import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não negatividade ficam no banco,
 * não só no código: qualquer caminho de escrita (API, fila, worker, psql) esbarra nelas.
 */
export class Migration20261110230000_schema_inicial extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance numeric(18,2) not null check (balance >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_uq unique (player_id, currency)
      );`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null check (provider_id <> ''),
        external_transaction_id text not null check (external_transaction_id <> ''),
        idempotency_key text not null check (idempotency_key <> ''),
        payload_hash char(64) not null,
        wallet_id uuid not null,
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(18,2) not null check (amount >= 0),
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions(id),
        status text not null check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code text,
        observed_balance numeric(18,2),
        correlation_id text not null,
        reference_attempts integer not null default 0 check (reference_attempts >= 0),
        next_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_tx_idempotency_key_uq unique (idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wager_tx_reference_required check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_failure_code check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wager_tx_processed_at check ((status in ('PROCESSED','REJECTED','FAILED')) = (processed_at is not null)),
        constraint wager_tx_pending_schedule check ((status = 'PENDING_REFERENCE') = (next_attempt_at is not null))
      );`);
    // uma referência só pode ser revertida uma vez: REFUND e ROLLBACK processados contam juntos
    this.addSql(`
      create unique index wager_tx_one_reversal_uq on wager_transactions (reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED';`);
    this.addSql(`create index wager_tx_pending_due_idx on wager_transactions (next_attempt_at) where status = 'PENDING_REFERENCE';`);
    this.addSql(
      `create index wager_tx_pending_reference_idx on wager_transactions (provider_id, reference_external_transaction_id) where status = 'PENDING_REFERENCE';`,
    );

    this.addSql(`
      create table wallet_ledger_entries (
        seq bigserial not null unique,
        id uuid primary key,
        wallet_id uuid not null references wallets(id),
        transaction_id uuid not null references wager_transactions(id),
        direction text not null check (direction in ('DEBIT','CREDIT')),
        amount numeric(18,2) not null check (amount > 0),
        currency char(3) not null,
        balance_before numeric(18,2) not null check (balance_before >= 0),
        balance_after numeric(18,2) not null check (balance_after >= 0),
        created_at timestamptz not null,
        constraint ledger_one_entry_per_transaction_uq unique (transaction_id),
        constraint ledger_balanced check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT' and balance_after = balance_before - amount))
      );`);
    this.addSql(`create index ledger_wallet_seq_idx on wallet_ledger_entries (wallet_id, seq);`);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );`);

    this.addSql(`
      create table outbox_messages (
        seq bigserial not null unique,
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz not null,
        published_at timestamptz
      );`);
    this.addSql(`create index outbox_due_idx on outbox_messages (next_attempt_at) where published_at is null;`);

    // ---- o extrato é só de inserção: UPDATE, DELETE e TRUNCATE são recusados pelo banco
    this.addSql(`
      create function forbid_change() returns trigger language plpgsql as $$
      begin
        raise exception '% em % não é permitido: o extrato é imutável', tg_op, tg_table_name using errcode = 'restrict_violation';
      end $$;`);
    this.addSql(
      `create trigger ledger_no_update_delete before update or delete on wallet_ledger_entries for each row execute function forbid_change();`,
    );
    this.addSql(
      `create trigger ledger_no_truncate before truncate on wallet_ledger_entries for each statement execute function forbid_change();`,
    );

    // ---- cada lançamento continua do saldo final do anterior da mesma wallet
    this.addSql(`
      create function ledger_check_chain() returns trigger language plpgsql as $$
      declare anterior numeric(18,2);
      begin
        select balance_after into anterior from wallet_ledger_entries
          where wallet_id = new.wallet_id and seq < new.seq order by seq desc limit 1;
        if coalesce(anterior, 0) <> new.balance_before then
          raise exception 'lançamento % quebra a sequência da wallet %: esperado %, veio %', new.id, new.wallet_id, coalesce(anterior, 0), new.balance_before
            using errcode = 'check_violation';
        end if;
        return null;
      end $$;`);
    this.addSql(`create trigger ledger_chain after insert on wallet_ledger_entries for each row execute function ledger_check_chain();`);

    // ---- no commit, o saldo da wallet tem que ser o saldo final do último lançamento dela
    this.addSql(`
      create function wallet_check_ledger() returns trigger language plpgsql as $$
      declare ultimo numeric(18,2);
      begin
        select balance_after into ultimo from wallet_ledger_entries where wallet_id = new.id order by seq desc limit 1;
        if coalesce(ultimo, 0) <> new.balance then
          raise exception 'saldo da wallet % (%) diverge do extrato (%)', new.id, new.balance, coalesce(ultimo, 0) using errcode = 'check_violation';
        end if;
        return null;
      end $$;`);
    this.addSql(`
      create constraint trigger wallet_balance_matches_ledger after insert or update on wallets
        deferrable initially deferred for each row execute function wallet_check_ledger();`);

    // ---- version sobe exatamente 1 quando o saldo muda, e fica parada quando não muda
    this.addSql(`
      create function wallet_check_version() returns trigger language plpgsql as $$
      begin
        if (new.balance <> old.balance and new.version <> old.version + 1) or (new.balance = old.balance and new.version <> old.version) then
          raise exception 'version da wallet % inválida: % -> % com saldo % -> %', new.id, old.version, new.version, old.balance, new.balance
            using errcode = 'check_violation';
        end if;
        return new;
      end $$;`);
    this.addSql(`create trigger wallet_version before update on wallets for each row execute function wallet_check_version();`);

    // ---- transação terminal não muda mais, e nenhuma transação é apagada
    this.addSql(`
      create function wager_tx_check_terminal() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'transações não são apagadas (%)', old.id using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'transação % já está em % e não muda mais', old.id, old.status using errcode = 'restrict_violation';
        end if;
        return new;
      end $$;`);
    this.addSql(
      `create trigger wager_tx_terminal before update or delete on wager_transactions for each row execute function wager_tx_check_terminal();`,
    );
  }

  override down(): void {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
    this.addSql(
      `drop function if exists forbid_change(), ledger_check_chain(), wallet_check_ledger(), wallet_check_version(), wager_tx_check_terminal();`,
    );
  }
}
