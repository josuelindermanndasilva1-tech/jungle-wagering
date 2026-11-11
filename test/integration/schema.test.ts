import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import { config } from '../../src/config';
import ormConfig from '../../src/infrastructure/database/mikro-orm.config';
import { createWallet, db, startApp, submit, type TestApp, wager } from '../support/infra';

// testes com banco, fila e processos de verdade: mais que os 5 s padrão do bun test
setDefaultTimeout(120_000);

// As garantias de unicidade, imutabilidade e não negatividade estão no schema: aqui o SQL vai direto ao banco,
// sem passar pela aplicação, e o banco tem que recusar.

let t: TestApp;
let w: { id: string; playerId: string };
let betId: string;

beforeAll(async () => {
  t = await startApp();
  w = await createWallet(t.url, '100.00');
  const r = await submit(t.url, wager(w, 'BET', '10.00'));
  betId = r.body.transactionId;
});
afterAll(() => t.close());

const tx = (corpo: (sql: SQL) => Promise<unknown>) => db.begin(corpo);

/** Roda o comando e exige que o banco recuse, com a mensagem esperada. */
async function recusa(acao: () => PromiseLike<unknown>, mensagem: RegExp): Promise<void> {
  let erro: unknown;
  try {
    await acao();
  } catch (e) {
    erro = e;
  }
  expect(String((erro as Error)?.message ?? 'o banco aceitou')).toMatch(mensagem);
}

describe('migrations', () => {
  test('são reversíveis: up, down e up de novo num banco vazio', async () => {
    const admin = new SQL({
      url: `postgres://${config.db.user}:${config.db.password}@${config.db.host}:${config.db.port}/wagering`,
      max: 1,
    });
    await admin.unsafe('drop database if exists wagering_migrations_test with (force)');
    await admin.unsafe('create database wagering_migrations_test');
    const orm = await MikroORM.init({ ...ormConfig, dbName: 'wagering_migrations_test' });
    const tabelas = async () =>
      (
        await orm.em
          .fork()
          .execute(`select tablename from pg_tables where schemaname = 'public' and tablename <> 'mikro_orm_migrations' order by 1`)
      ).map((r: any) => r.tablename);
    await orm.migrator.up();
    const depoisDoUp = await tabelas();
    await orm.migrator.down();
    expect(await tabelas()).toEqual([]);
    await orm.migrator.up();
    expect(await tabelas()).toEqual(depoisDoUp);
    expect(depoisDoUp).toEqual(['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets']);
    await orm.close(true);
    await admin.unsafe('drop database wagering_migrations_test with (force)');
    await admin.close();
  });
});

describe('wallets', () => {
  test('saldo negativo é recusado pelo banco', async () => {
    await recusa(() => tx(sql => sql`update wallets set balance = -1, version = version + 1 where id = ${w.id}`), /check constraint/);
  });

  test('uma wallet por player e moeda', async () => {
    await recusa(
      () => db`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
         values (${Bun.randomUUIDv7()}, ${w.playerId}, 'BRL', 0, 1, now(), now())`,
      /wallets_player_currency_uq/,
    );
  });

  test('saldo que não bate com o extrato é recusado no commit', async () => {
    await recusa(
      () => tx(sql => sql`update wallets set balance = balance + 1, version = version + 1 where id = ${w.id}`),
      /diverge do extrato/,
    );
    const id = Bun.randomUUIDv7();
    await recusa(
      () => db`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
         values (${id}, ${crypto.randomUUID()}, 'BRL', 50, 1, now(), now())`,
      /diverge do extrato/,
    );
  });

  test('version sobe exatamente 1 quando o saldo muda, e só quando muda', async () => {
    await recusa(() => tx(sql => sql`update wallets set version = version + 1 where id = ${w.id}`), /version da wallet/);
  });
});

describe('wager_transactions', () => {
  const colunas = (key: string, ext: string, kind = 'BET', ref: string | null = null) => ({
    id: Bun.randomUUIDv7(),
    provider_id: 'provider-a',
    external_transaction_id: ext,
    idempotency_key: key,
    payload_hash: 'a'.repeat(64),
    wallet_id: w.id,
    player_id: w.playerId,
    round_id: 'r',
    game_id: 'g',
    kind,
    amount: '1.00',
    currency: 'BRL',
    reference_external_transaction_id: ref,
    status: 'PENDING',
    correlation_id: 'c',
    created_at: new Date(),
  });
  const inserir = (c: ReturnType<typeof colunas>) => db`insert into wager_transactions ${db(c)}`;

  test('a chave de idempotência e o par (provider, id externo) são únicos', async () => {
    const [orig] = await db`select idempotency_key, external_transaction_id from wager_transactions where id = ${betId}`;
    await recusa(() => inserir(colunas(orig.idempotency_key, `novo-${crypto.randomUUID()}`)), /wager_tx_idempotency_key_uq/);
    await recusa(() => inserir(colunas(`nova-${crypto.randomUUID()}`, orig.external_transaction_id)), /wager_tx_provider_external_uq/);
  });

  test('REFUND e ROLLBACK sem referência são recusados', async () => {
    await recusa(() => inserir(colunas(crypto.randomUUID(), crypto.randomUUID(), 'REFUND')), /wager_tx_reference_required/);
  });

  test('kind e status fora da lista são recusados', async () => {
    await recusa(() => inserir({ ...colunas(crypto.randomUUID(), crypto.randomUUID()), kind: 'JACKPOT' }), /check constraint/);
    await recusa(() => inserir({ ...colunas(crypto.randomUUID(), crypto.randomUUID()), status: 'DONE' }), /check constraint/);
  });

  test('transação terminal não muda mais e nenhuma é apagada', async () => {
    await recusa(() => db`update wager_transactions set failure_code = 'X' where id = ${betId}`, /não muda mais/);
    await recusa(() => db`delete from wager_transactions where id = ${betId}`, /não são apagadas/);
  });

  test('uma referência só aceita uma reversão processada', async () => {
    const [bet] = await db`select external_transaction_id from wager_transactions where id = ${betId}`;
    const r = await submit(t.url, wager(w, 'REFUND', '10.00', { referenceExternalTransactionId: bet.external_transaction_id }));
    expect(r.body.status).toBe('PROCESSED');
    const segunda = {
      ...colunas(crypto.randomUUID(), crypto.randomUUID(), 'ROLLBACK', bet.external_transaction_id),
      status: 'PROCESSED',
      reference_transaction_id: betId,
      processed_at: new Date(),
    };
    await recusa(() => inserir(segunda as never), /wager_tx_one_reversal_uq/);
  });
});

describe('wallet_ledger_entries', () => {
  test('UPDATE, DELETE e TRUNCATE são recusados: o extrato é imutável', async () => {
    await recusa(() => db`update wallet_ledger_entries set amount = amount where wallet_id = ${w.id}`, /imutável/);
    await recusa(() => db`delete from wallet_ledger_entries where wallet_id = ${w.id}`, /imutável/);
    await recusa(() => db`truncate wallet_ledger_entries cascade`, /imutável/);
  });

  test('lançamento com aritmética errada ou quebrando a sequência é recusado', async () => {
    const [ultimo] =
      await db`select balance_after::text, transaction_id from wallet_ledger_entries where wallet_id = ${w.id} order by seq desc limit 1`;
    const novo = (antes: string, valor: string, depois: string) => db`
      insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
      values (${Bun.randomUUIDv7()}, ${w.id}, ${betId}, 'CREDIT', ${valor}, 'BRL', ${antes}, ${depois}, now())`;
    await recusa(() => novo(ultimo.balance_after, '5.00', '999.00'), /ledger_balanced/);
    await recusa(() => novo('1.00', '5.00', '6.00'), /ledger_one_entry_per_transaction_uq|quebra a sequência/);
  });
});
