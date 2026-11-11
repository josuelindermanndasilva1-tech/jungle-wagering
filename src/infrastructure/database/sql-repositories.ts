import { InvalidRequestError } from '../../application/errors';
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  Repositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/ledger-entry';
import { InboxMessage, OutboxMessage } from '../../domain/messaging';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from '../../domain/wager-transaction';
import type { FailureCode } from '../../domain/failure-codes';
import type { Sql } from './database';

// Datas vão como texto ISO com cast explícito; undefined vira NULL.
const iso = (d?: Date): string | null => (d ? d.toISOString() : null);
const data = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const talvez = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

type Row = Record<string, any>;

const walletDaLinha = (r: Row): Wallet =>
  Wallet.rehydrate({
    id: r.id,
    playerId: r.player_id,
    currency: r.currency,
    balance: Money.fromPersisted(String(r.balance), r.currency),
    version: Number(r.version),
    createdAt: data(r.created_at),
    updatedAt: data(r.updated_at),
  });

const transacaoDaLinha = (r: Row): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.provider_id,
    externalTransactionId: r.external_transaction_id,
    idempotencyKey: r.idempotency_key,
    payloadHash: r.payload_hash,
    walletId: r.wallet_id,
    playerId: r.player_id,
    roundId: r.round_id,
    gameId: r.game_id,
    kind: r.kind as WagerTransactionKind,
    money: Money.fromPersisted(String(r.amount), r.currency),
    referenceExternalTransactionId: talvez(r.reference_external_transaction_id),
    createdAt: data(r.created_at),
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: talvez(r.reference_transaction_id),
    failureCode: talvez(r.failure_code) as FailureCode | undefined,
    processedAt: r.processed_at ? data(r.processed_at) : undefined,
    observedBalance: r.observed_balance === null ? undefined : Money.fromPersisted(String(r.observed_balance), r.currency),
    referenceAttempts: Number(r.reference_attempts),
    nextAttemptAt: r.next_attempt_at ? data(r.next_attempt_at) : undefined,
  });

const lancamentoDaLinha = (r: Row): WalletLedgerEntry =>
  WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.wallet_id,
    transactionId: r.transaction_id,
    direction: r.direction as LedgerDirection,
    money: Money.fromPersisted(String(r.amount), r.currency),
    balanceBefore: Money.fromPersisted(String(r.balance_before), r.currency),
    balanceAfter: Money.fromPersisted(String(r.balance_after), r.currency),
    createdAt: data(r.created_at),
  });

const outboxDaLinha = (r: Row): OutboxMessage =>
  OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregate_id,
    eventType: r.event_type,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
    occurredAt: data(r.occurred_at),
    attempts: Number(r.attempts),
    nextAttemptAt: r.next_attempt_at ? data(r.next_attempt_at) : undefined,
    publishedAt: r.published_at ? data(r.published_at) : undefined,
  });

// O cursor do extrato é opaco para o cliente: o `seq` (ordem de inserção) em base64url.
const codificarCursor = (seq: string): string => Buffer.from(`seq:${seq}`).toString('base64url');
function decodificarCursor(cursor: string): string {
  const texto = Buffer.from(cursor, 'base64url').toString();
  const m = /^seq:(\d{1,19})$/.exec(texto);
  if (!m) throw new InvalidRequestError('cursor inválido');
  return m[1]!;
}

function wallets(sql: Sql): WalletRepository {
  return {
    async insert(w) {
      const rows = await sql.all(
        `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz)
         on conflict (player_id, currency) do nothing
         returning id`,
        [w.id, w.playerId, w.currency, w.balance.toString(), w.version, iso(w.createdAt), iso(w.updatedAt)],
      );
      return rows.length === 1;
    },
    async find(id) {
      const r = await sql.one(`select * from wallets where id = ?`, [id]);
      return r && walletDaLinha(r);
    },
    async findForUpdate(id) {
      const r = await sql.one(`select * from wallets where id = ? for update`, [id]);
      return r && walletDaLinha(r);
    },
    async saveBalance(w, expectedVersion) {
      const n = await sql.run(`update wallets set balance = ?, version = ?, updated_at = ?::timestamptz where id = ? and version = ?`, [
        w.balance.toString(),
        w.version,
        iso(w.updatedAt),
        w.id,
        expectedVersion,
      ]);
      if (n !== 1) throw new Error(`a wallet ${w.id} mudou de version durante a transação`);
    },
    async reconciliationTotals(walletId) {
      // um comando só = um snapshot só: saldo guardado e soma do extrato não podem ser lidos em momentos diferentes
      const r = await sql.one(
        `select w.balance, w.currency,
                coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0) as calculated,
                count(l.id) as entries
           from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
          where w.id = ?
          group by w.id`,
        [walletId],
      );
      if (!r) return undefined;
      return {
        stored: Money.fromPersisted(String(r.balance), r.currency),
        calculated: Money.fromPersisted(String(r.calculated), r.currency),
        entries: Number(r.entries),
      };
    },
  };
}

function transactions(sql: Sql): WagerTransactionRepository {
  const umaPor = async (where: string, params: unknown[]) => {
    const r = await sql.one(`select * from wager_transactions where ${where}`, params);
    return r && transacaoDaLinha(r);
  };
  return {
    async insertIfAbsent(t, correlationId) {
      const rows = await sql.all(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code,
            observed_balance, correlation_id, reference_attempts, next_attempt_at, created_at, processed_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz, ?::timestamptz)
         on conflict do nothing
         returning id`,
        [
          t.id,
          t.providerId,
          t.externalTransactionId,
          t.idempotencyKey,
          t.payloadHash,
          t.walletId,
          t.playerId,
          t.roundId,
          t.gameId,
          t.kind,
          t.money.toString(),
          t.money.currency,
          t.referenceExternalTransactionId ?? null,
          t.referenceTransactionId ?? null,
          t.status,
          t.failureCode ?? null,
          t.observedBalance?.toString() ?? null,
          correlationId,
          t.referenceAttempts,
          iso(t.nextAttemptAt),
          iso(t.createdAt),
          iso(t.processedAt),
        ],
      );
      return rows.length === 1;
    },
    findById: id => umaPor('id = ?', [id]),
    findByIdempotencyKey: key => umaPor('idempotency_key = ?', [key]),
    findByExternalId: (providerId, externalId) => umaPor('provider_id = ? and external_transaction_id = ?', [providerId, externalId]),
    async hasProcessedReversal(referenceId) {
      const r = await sql.one(
        `select 1 as sim from wager_transactions
          where reference_transaction_id = ? and kind in ('REFUND','ROLLBACK') and status = 'PROCESSED' limit 1`,
        [referenceId],
      );
      return r !== undefined;
    },
    async save(t) {
      const n = await sql.run(
        `update wager_transactions
            set status = ?, reference_transaction_id = ?, failure_code = ?, observed_balance = ?,
                reference_attempts = ?, next_attempt_at = ?::timestamptz, processed_at = ?::timestamptz
          where id = ?`,
        [
          t.status,
          t.referenceTransactionId ?? null,
          t.failureCode ?? null,
          t.observedBalance?.toString() ?? null,
          t.referenceAttempts,
          iso(t.nextAttemptAt),
          iso(t.processedAt),
          t.id,
        ],
      );
      if (n !== 1) throw new Error(`transação ${t.id} não encontrada para atualizar`);
    },
    async findDuePendingIds(now, limit) {
      const rows = await sql.all<{ id: string }>(
        `select id from wager_transactions
          where status = 'PENDING_REFERENCE' and next_attempt_at <= ?::timestamptz
          order by next_attempt_at limit ?`,
        [iso(now), limit],
      );
      return rows.map(r => r.id);
    },
    async lockDuePending(id, now) {
      const r = await sql.one(
        `select * from wager_transactions
          where id = ? and status = 'PENDING_REFERENCE' and next_attempt_at <= ?::timestamptz
          for update skip locked`,
        [id, iso(now)],
      );
      return r && { transaction: transacaoDaLinha(r), correlationId: r.correlation_id };
    },
    async wakePendingReferencing(providerId, externalId, now) {
      // SKIP LOCKED: uma pendente que o worker já está tratando fica como está (e ninguém espera por trava)
      await sql.run(
        `update wager_transactions set next_attempt_at = ?::timestamptz
          where id in (select id from wager_transactions
                        where status = 'PENDING_REFERENCE' and provider_id = ? and reference_external_transaction_id = ?
                          and next_attempt_at > ?::timestamptz
                        for update skip locked)`,
        [iso(now), providerId, externalId, iso(now)],
      );
    },
  };
}

function ledger(sql: Sql): LedgerRepository {
  return {
    async insert(e) {
      await sql.run(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz)`,
        [
          e.id,
          e.walletId,
          e.transactionId,
          e.direction,
          e.money.toString(),
          e.money.currency,
          e.balanceBefore.toString(),
          e.balanceAfter.toString(),
          iso(e.createdAt),
        ],
      );
    },
    async page(walletId, cursor, limit) {
      const depoisDe = cursor ? decodificarCursor(cursor) : '0';
      const rows = await sql.all(`select * from wallet_ledger_entries where wallet_id = ? and seq > ?::bigint order by seq limit ?`, [
        walletId,
        depoisDe,
        limit + 1,
      ]);
      const pagina = rows.slice(0, limit);
      const ultimo = pagina[pagina.length - 1];
      return {
        entries: pagina.map(lancamentoDaLinha),
        nextCursor: rows.length > limit && ultimo ? codificarCursor(String(ultimo.seq)) : undefined,
      };
    },
  };
}

function outbox(sql: Sql): OutboxRepository {
  return {
    async add(msgs) {
      if (!msgs.length) return;
      const linhas = msgs.map(() => '(?, ?, ?, ?::jsonb, ?::timestamptz, ?, ?::timestamptz)').join(', ');
      await sql.run(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at) values ${linhas}`,
        msgs.flatMap(m => [
          m.id,
          m.aggregateId,
          m.eventType,
          JSON.stringify(m.payload),
          iso(m.occurredAt),
          m.attempts,
          iso(m.nextAttemptAt ?? m.occurredAt),
        ]),
      );
    },
    async lockDue(now, limit) {
      const rows = await sql.all(
        `select * from outbox_messages
          where published_at is null and next_attempt_at <= ?::timestamptz
          order by seq limit ?
          for update skip locked`,
        [iso(now), limit],
      );
      return rows.map(outboxDaLinha);
    },
    async save(msgs) {
      for (const m of msgs) {
        await sql.run(
          `update outbox_messages set attempts = ?, next_attempt_at = ?::timestamptz, published_at = ?::timestamptz where id = ?`,
          [m.attempts, iso(m.nextAttemptAt ?? m.occurredAt), iso(m.publishedAt), m.id],
        );
      }
    },
    async oldestPendingAgeSeconds(now) {
      const r = await sql.one(
        `select extract(epoch from (?::timestamptz - min(occurred_at))) as lag from outbox_messages where published_at is null`,
        [iso(now)],
      );
      return r?.lag == null ? 0 : Math.max(0, Number(r.lag));
    },
  };
}

function inbox(sql: Sql): InboxRepository {
  return {
    async receive(m) {
      const novas = await sql.all(
        `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
         values (?, ?, ?, ?::timestamptz, ?::timestamptz)
         on conflict do nothing
         returning message_id`,
        [m.consumerName, m.messageId, m.payloadHash, iso(m.receivedAt), iso(m.processedAt)],
      );
      if (novas.length) return undefined;
      const r = await sql.one(`select * from inbox_messages where consumer_name = ? and message_id = ?`, [m.consumerName, m.messageId]);
      return (
        r &&
        InboxMessage.rehydrate({
          messageId: r.message_id,
          consumerName: r.consumer_name,
          payloadHash: r.payload_hash,
          receivedAt: data(r.received_at),
          processedAt: r.processed_at ? data(r.processed_at) : undefined,
        })
      );
    },
    async save(m) {
      await sql.run(`update inbox_messages set processed_at = ?::timestamptz where consumer_name = ? and message_id = ?`, [
        iso(m.processedAt),
        m.consumerName,
        m.messageId,
      ]);
    },
  };
}

export const sqlRepositories = (sql: Sql): Repositories => ({
  wallets: wallets(sql),
  transactions: transactions(sql),
  ledger: ledger(sql),
  outbox: outbox(sql),
  inbox: inbox(sql),
});
