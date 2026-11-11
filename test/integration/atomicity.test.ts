import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { parseWagerCommand } from '../../src/application/input';
import { type Repositories, UnitOfWork } from '../../src/application/ports';
import { ProcessWager } from '../../src/application/process-wager';
import { createWallet, db, startApp, type TestApp, wager, walletState } from '../support/infra';

// testes com banco, fila e processos de verdade: mais que os 5 s padrão do bun test
setDefaultTimeout(120_000);

// Inbox, transação, saldo, extrato e outbox entram juntos ou não entram: aqui a última etapa (outbox) falha
// e nada pode ter ficado gravado.

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

/** O mesmo banco de verdade, mas com a gravação da outbox quebrada no meio da transação. */
class OutboxQuebrada extends UnitOfWork {
  constructor(private readonly real: UnitOfWork) {
    super();
  }
  run<T>(fn: (r: Repositories) => Promise<T>): Promise<T> {
    return this.real.run(r =>
      fn({
        ...r,
        outbox: {
          ...r.outbox,
          add: async () => {
            throw new Error('outbox indisponível (falha simulada)');
          },
        },
      }),
    );
  }
  read<T>(fn: (r: Repositories) => Promise<T>): Promise<T> {
    return this.real.read(fn);
  }
  isTransient(e: unknown): boolean {
    return this.real.isTransient(e);
  }
}

describe('atomicidade', () => {
  test('falha depois de debitar e lançar: nada fica gravado (wallet, extrato, transação, inbox)', async () => {
    const w = await createWallet(t.url, '100.00');
    const antes = await walletState(w.id);
    const body = wager(w, 'BET', '30.00');
    const quebrado = new ProcessWager(new OutboxQuebrada(t.app.get(UnitOfWork)));
    const messageId = crypto.randomUUID();

    let erro: unknown;
    try {
      await quebrado.execute(parseWagerCommand(body, 'k-' + body.externalTransactionId), {
        source: 'sqs',
        correlationId: 'c1',
        inbox: { consumerName: 'teste', messageId, payloadHash: 'h' },
      });
    } catch (e) {
      erro = e;
    }
    expect(String((erro as Error)?.message)).toContain('falha simulada');

    expect(await walletState(w.id)).toEqual(antes);
    expect(
      (await db`select count(*)::int as n from wager_transactions where external_transaction_id = ${body.externalTransactionId}`)[0].n,
    ).toBe(0);
    expect((await db`select count(*)::int as n from inbox_messages where message_id = ${messageId}`)[0].n).toBe(0);

    // e o mesmo pedido, sem a falha, passa normalmente depois: nada ficou pela metade
    const ok = await t.app
      .get(ProcessWager)
      .execute(parseWagerCommand(body, 'k-' + body.externalTransactionId), { source: 'http', correlationId: 'c2' });
    expect(ok.type === 'settled' ? String(ok.transaction.status) : ok.type).toBe('PROCESSED');
    const depois = await walletState(w.id);
    expect([depois.balance, depois.ledgerBalance, depois.chained]).toEqual(['70.00', '70.00', true]);
  });
});
