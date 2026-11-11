import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { UnitOfWork } from '../../src/application/ports';
import { ProcessWager } from '../../src/application/process-wager';
import type { OutboxMessage } from '../../src/domain/messaging';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs';
import { CONSUMER_NAME, parseWagerMessage, WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { OutboxPublisher } from '../../src/infrastructure/messaging/workers';
import {
  createWallet,
  db,
  sendWagerMessage,
  spawnInstance,
  startApp,
  submit,
  submitWithRetry,
  type TestApp,
  wager,
  walletState,
} from '../support/infra';

// testes com banco, fila e processos de verdade: mais que os 5 s padrão do bun test
setDefaultTimeout(120_000);

// Paralelismo real: requisições simultâneas em conexões diferentes do pool, e processos separados.
// Invariante final de todos: wallet.balance == saldo reconstruído pelo extrato.

let t: TestApp;
let sqs: SqsGateway;
const sinal = new AbortController().signal;

beforeAll(async () => {
  t = await startApp();
  sqs = t.app.get(SqsGateway);
});
afterAll(() => t.close());

async function consumirTudo(consumer = t.app.get(WagerConsumer)) {
  for (let vazias = 0; vazias < 2;) {
    const lote = await sqs.receive(sinal);
    if (lote.length) await consumer.processBatch(lote);
    else vazias++;
  }
}

async function consistente(walletId: string) {
  const s = await walletState(walletId);
  expect(s.ledgerBalance).toBe(s.balance);
  expect(s.chained).toBe(true);
  return s;
}

const esperar = async (cond: () => Promise<boolean>, ms = 20_000) => {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await cond()) return true;
    await Bun.sleep(100);
  }
  return false;
};

describe('1. a mesma aposta 50 vezes em paralelo', () => {
  test('um único débito; as outras 49 são replay do mesmo resultado', async () => {
    const w = await createWallet(t.url, '100.00');
    const b = wager(w, 'BET', '10.00');
    const rs = await Promise.all(Array.from({ length: 50 }, () => submit(t.url, b)));
    expect(rs.every(r => r.status === 200)).toBe(true);
    expect(new Set(rs.map(r => r.body.transactionId)).size).toBe(1);
    expect(rs.filter(r => !r.body.idempotentReplay)).toHaveLength(1);
    expect(rs.every(r => r.body.balance.amount === '90.00')).toBe(true);
    const s = await consistente(w.id);
    expect([s.balance, s.entries]).toEqual(['90.00', 2]);
  });
});

describe('2. apostas disputando o saldo da mesma wallet', () => {
  test('cenário obrigatório: 100.00 e duas apostas de 80.00 ao mesmo tempo (20 wallets de uma vez)', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(t.url, '100.00')));
    await Promise.all(
      wallets.map(async w => {
        const [a, b] = await Promise.all([submit(t.url, wager(w, 'BET', '80.00')), submit(t.url, wager(w, 'BET', '80.00'))]);
        expect([a.body.status, b.body.status].sort()).toEqual(['PROCESSED', 'REJECTED']);
        expect([a, b].find(r => r.body.status === 'REJECTED')!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
        const s = await consistente(w.id);
        expect(s.balance).toBe('20.00');
        const debitos = await db`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${w.id} and direction = 'DEBIT'`;
        expect(debitos[0].n).toBe(1);
      }),
    );
  });

  test('wallet quente: 60 apostas de 10.00 com 200.00; exatamente 20 passam, nunca negativo', async () => {
    const w = await createWallet(t.url, '200.00');
    const rs = await Promise.all(Array.from({ length: 60 }, () => submit(t.url, wager(w, 'BET', '10.00'))));
    expect(rs.filter(r => r.body.status === 'PROCESSED')).toHaveLength(20);
    expect(rs.filter(r => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(40);
    const s = await consistente(w.id);
    expect([s.balance, s.entries, s.version]).toEqual(['0.00', 21, 21]);
  });
});

describe('3. wallets distintas em paralelo', () => {
  test('30 wallets, 10 apostas cada, tudo ao mesmo tempo: nenhuma interfere na outra', async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, () => createWallet(t.url, '100.00')));
    await Promise.all(wallets.flatMap(w => Array.from({ length: 10 }, () => submit(t.url, wager(w, 'BET', '5.00')))));
    for (const w of wallets) {
      const s = await consistente(w.id);
      expect([s.balance, s.entries]).toEqual(['50.00', 11]);
    }
  });
});

describe('4. três instâncias ao mesmo tempo', () => {
  test('API e fila em 3 processos: cada chave vale uma vez, o saldo nunca fica negativo', async () => {
    const instancias = await Promise.all(['inst-1', 'inst-2', 'inst-3'].map(n => spawnInstance(n)));
    try {
      const quente = await createWallet(instancias[0]!.url, '1000.00');
      // 150 apostas de 10.00; cada uma enviada duas vezes, para instâncias diferentes
      const apostas = Array.from({ length: 150 }, () => wager(quente, 'BET', '10.00'));
      const rs = await Promise.all(
        apostas.flatMap((b, i) => [submitWithRetry(instancias[i % 3]!.url, b), submitWithRetry(instancias[(i + 1) % 3]!.url, b)]),
      );
      const porChave = new Map<string, Set<string>>();
      rs.forEach((r, i) =>
        porChave.set(
          apostas[Math.floor(i / 2)]!.externalTransactionId,
          (porChave.get(apostas[Math.floor(i / 2)]!.externalTransactionId) ?? new Set()).add(r.body.transactionId),
        ),
      );
      expect(rs.every(r => r.status === 200 || r.status === 422)).toBe(true);
      expect([...porChave.values()].every(ids => ids.size === 1)).toBe(true);
      const processadas =
        await db`select count(*)::int as n from wager_transactions where wallet_id = ${quente.id} and kind = 'BET' and status = 'PROCESSED'`;
      expect(processadas[0].n).toBe(100);
      const s = await consistente(quente.id);
      expect([s.balance, s.entries]).toEqual(['0.00', 101]);

      // a fila consumida pelas três ao mesmo tempo
      const outra = await createWallet(instancias[1]!.url, '100.00');
      const pela_fila = Array.from({ length: 30 }, () => wager(outra, 'BET', '1.00'));
      await Promise.all(pela_fila.map(b => sendWagerMessage(b)));
      await Promise.all(pela_fila.slice(0, 10).map(b => sendWagerMessage(b))); // dez duplicadas com outro messageId
      expect(await esperar(async () => (await walletState(outra.id)).balance === '70.00')).toBe(true);
      await Bun.sleep(1500);
      const s2 = await consistente(outra.id);
      expect([s2.balance, s2.entries]).toEqual(['70.00', 31]);
    } finally {
      await Promise.all(instancias.map(i => i.stop()));
    }
  });
});

describe('5. worker morto depois do commit e antes do ack', () => {
  test('a mensagem volta, a inbox reconhece e o efeito acontece uma vez só', async () => {
    await consumirTudo();
    const w = await createWallet(t.url, '100.00');
    await sendWagerMessage(wager(w, 'BET', '25.00'));
    const [m] = await sqs.receive(sinal);
    const pedido = parseWagerMessage(m!.Body!);
    // o worker processa e confirma no banco...
    await t.app.get(ProcessWager).execute(pedido.command, {
      source: 'sqs',
      correlationId: pedido.correlationId,
      causationId: pedido.messageId,
      inbox: { consumerName: CONSUMER_NAME, messageId: pedido.messageId, payloadHash: pedido.bodyHash },
    });
    // ...e morre antes do DeleteMessage. A SQS devolveria a mensagem depois do visibility timeout; aqui, na hora.
    await sqs.changeVisibility(m!, 0);
    await consumirTudo();
    const s = await consistente(w.id);
    expect([s.balance, s.entries]).toEqual(['75.00', 2]);
    expect(await sqs.receive(sinal)).toHaveLength(0);
  });
});

describe('6. dois publishers sobre a mesma outbox', () => {
  test('cada evento é publicado por um só, e nenhum fica para trás', async () => {
    const w = await createWallet(t.url, '100.00');
    await Promise.all(Array.from({ length: 15 }, () => submit(t.url, wager(w, 'BET', '1.00'))));
    const ids = (await db`select id from outbox_messages where aggregate_id = ${w.id}`).map((r: any) => r.id as string);
    expect(ids).toHaveLength(31);

    const publicacoes = new Map<string, number>();
    class Contador extends SqsGateway {
      override async publishEvents(ms: OutboxMessage[]) {
        for (const m of ms) publicacoes.set(m.id, (publicacoes.get(m.id) ?? 0) + 1);
        await Bun.sleep(20); // abre a janela de corrida entre os dois
        return super.publishEvents(ms);
      }
    }
    const uow = t.app.get(UnitOfWork);
    const a = new OutboxPublisher(uow, new Contador());
    const b = new OutboxPublisher(uow, new Contador());
    while (true) {
      const [x, y] = await Promise.all([a.publishBatch(), b.publishBatch()]);
      if (x + y === 0) break;
    }
    expect(ids.every((id: string) => publicacoes.get(id) === 1)).toBe(true);
    const pendentes = await db`select count(*)::int as n from outbox_messages where aggregate_id = ${w.id} and published_at is null`;
    expect(pendentes[0].n).toBe(0);
  });
});

describe('7. REFUND ou ROLLBACK antes da referência', () => {
  test('o REFUND espera em PENDING_REFERENCE e é aplicado quando a BET chega', async () => {
    const w = await createWallet(t.url, '100.00');
    const bet = wager(w, 'BET', '30.00');
    const refund = wager(w, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect((await submit(t.url, refund)).body.status).toBe('PENDING_REFERENCE');
    expect((await submit(t.url, bet)).body.balance.amount).toBe('70.00');
    await t.app.get(ProcessWager).retryDuePending();
    const replay = await submit(t.url, refund);
    expect([replay.status, replay.body.status, replay.body.balance.amount]).toEqual([200, 'PROCESSED', '100.00']);
    await consistente(w.id);
  });

  test('ROLLBACK de um WIN que chega antes do próprio WIN e enviado em paralelo, 20 vezes', async () => {
    const w = await createWallet(t.url, '100.00');
    const win = wager(w, 'WIN', '50.00');
    const rollback = wager(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId });
    await Promise.all(Array.from({ length: 10 }, () => submit(t.url, rollback)));
    await Promise.all([
      ...Array.from({ length: 10 }, () => submit(t.url, rollback)),
      ...Array.from({ length: 10 }, () => submit(t.url, win)),
    ]);
    await esperar(
      async () => (await t.app.get(ProcessWager).retryDuePending()) === 0 && (await submit(t.url, rollback)).body.status === 'PROCESSED',
    );
    const s = await consistente(w.id);
    expect([s.balance, s.entries]).toEqual(['100.00', 3]);
  });

  test('referência que nunca chega: REJECTED com REFERENCE_NOT_FOUND e evento publicado', async () => {
    const w = await createWallet(t.url, '100.00');
    const refund = wager(w, 'REFUND', '5.00', { referenceExternalTransactionId: 'nunca-vai-chegar' });
    await submit(t.url, refund);
    const pw = t.app.get(ProcessWager);
    expect(await esperar(async () => (await pw.retryDuePending(), (await submit(t.url, refund)).body.status === 'REJECTED'))).toBe(true);
    expect((await submit(t.url, refund)).body.failureCode).toBe('REFERENCE_NOT_FOUND');
    const tipos = (await db`select event_type from outbox_messages where aggregate_id = ${w.id} order by seq`).map(
      (r: any) => r.event_type,
    );
    expect(tipos.filter((x: string) => x === 'WagerTransactionPendingReference').length).toBe(3);
    expect(tipos.at(-1)).toBe('WagerTransactionRejected');
  });
});

describe('8. reinício do serviço', () => {
  test('processo morto com kill -9 no meio da carga: depois do reinício, tudo consistente e a outbox drenada', async () => {
    const a = await spawnInstance('antes-do-crash');
    const w = await createWallet(a.url, '200.00');
    const apostas = Array.from({ length: 60 }, () => wager(w, 'BET', '5.00'));
    const fila = Array.from({ length: 20 }, () => wager(w, 'BET', '1.00'));
    await Promise.all(fila.map(b => sendWagerMessage(b)));
    const emVoo = Promise.allSettled(apostas.map(b => submit(a.url, b)));
    await Bun.sleep(150);
    await a.stop('SIGKILL'); // sem chance de terminar nada
    await emVoo;

    const b = await spawnInstance('depois-do-crash');
    try {
      // o provedor reenvia tudo o que não teve resposta (e o que teve, o replay devolve igual)
      const rs = await Promise.all(apostas.map(x => submitWithRetry(b.url, x)));
      expect(rs.every(r => r.status === 200 || r.status === 422)).toBe(true);
      // as mensagens da fila que estavam com o processo morto voltam depois do visibility timeout
      const terminou = await esperar(async () => {
        const n =
          await db`select count(*)::int as n from wager_transactions where wallet_id = ${w.id} and provider_id = 'provider-a' and status in ('PROCESSED','REJECTED')`;
        return n[0].n === 80;
      }, 30_000);
      expect(terminou).toBe(true);
      const porChave =
        await db`select idempotency_key, count(*)::int as n from wager_transactions where wallet_id = ${w.id} group by 1 having count(*) > 1`;
      expect(porChave).toHaveLength(0);
      const s = await consistente(w.id);
      const debitado =
        await db`select coalesce(sum(amount), 0)::text as total from wager_transactions where wallet_id = ${w.id} and kind = 'BET' and status = 'PROCESSED'`;
      expect(Number(s.balance) + Number(debitado[0].total)).toBe(200);
      const reconc: any = await (await fetch(`${b.url}/wallets/${w.id}/reconciliation`, { method: 'POST' })).json();
      expect(reconc.consistent).toBe(true);
      // a outbox da instância nova publica o que ficou pendente
      expect(
        await esperar(
          async () =>
            (await db`select count(*)::int as n from outbox_messages where aggregate_id = ${w.id} and published_at is null`)[0].n === 0,
        ),
      ).toBe(true);
    } finally {
      await b.stop();
    }
  });
});
