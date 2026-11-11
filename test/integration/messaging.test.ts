import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { UnitOfWork } from '../../src/application/ports';
import type { ProcessWager } from '../../src/application/process-wager';
import { config } from '../../src/config';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { OutboxPublisher } from '../../src/infrastructure/messaging/workers';
import { createWallet, db, drainQueue, sendWagerMessage, startApp, submit, type TestApp, wager, walletState } from '../support/infra';

// testes com banco, fila e processos de verdade: mais que os 5 s padrão do bun test
setDefaultTimeout(120_000);

let t: TestApp;
let sqs: SqsGateway;
let consumer: WagerConsumer;
const sinal = new AbortController().signal;

beforeAll(async () => {
  t = await startApp();
  sqs = t.app.get(SqsGateway);
  consumer = t.app.get(WagerConsumer);
});
afterAll(() => t.close());

/** Recebe e processa até a fila esvaziar, como o laço do consumidor faria. */
async function consumirTudo(c = consumer) {
  for (let vazias = 0; vazias < 2;) {
    const lote = await sqs.receive(sinal);
    if (lote.length) await c.processBatch(lote);
    else vazias++;
  }
}

describe('consumidor SQS', () => {
  test('mesmo messageId entregue duas vezes: um efeito só (inbox), as duas mensagens confirmadas', async () => {
    await consumirTudo();
    const w = await createWallet(t.url, '100.00');
    const b = wager(w, 'BET', '15.00');
    const env = await sendWagerMessage(b, 'msg-' + crypto.randomUUID());
    await sendWagerMessage(b, env.messageId); // reentrega com outro occurredAt: continua a mesma mensagem
    await consumirTudo();
    const s = await walletState(w.id);
    expect([s.balance, s.entries, s.chained]).toEqual(['85.00', 2, true]);
    expect((await db`select count(*)::int as n from inbox_messages where message_id = ${env.messageId}`)[0].n).toBe(1);
  });

  test('mensagens diferentes com a mesma chave de idempotência: replay, um débito só', async () => {
    const w = await createWallet(t.url, '100.00');
    const b = wager(w, 'BET', '10.00');
    await sendWagerMessage(b);
    await sendWagerMessage(b);
    await consumirTudo();
    expect((await walletState(w.id)).balance).toBe('90.00');
  });

  test('a mesma transação pela API e pela fila: o mesmo caso de uso, um efeito só', async () => {
    const w = await createWallet(t.url, '100.00');
    const b = wager(w, 'BET', '7.00');
    expect((await submit(t.url, b)).status).toBe(200);
    await sendWagerMessage(b);
    await consumirTudo();
    expect((await walletState(w.id)).balance).toBe('93.00');
  });

  test('mensagem inválida vai direto para a DLQ, com o motivo', async () => {
    const w = await createWallet(t.url, '100.00');
    await sendWagerMessage(
      { ...wager(w, 'BET', '1.00'), money: { amount: '1e3', currency: 'BRL' } },
      'msg-invalida-' + crypto.randomUUID(),
    );
    await consumirTudo();
    const dlq = await drainQueue(config.sqs.deadLetterQueue, corpos => corpos.some(c => c.includes('msg-invalida-')));
    const m = dlq.find(x => x.body.includes('msg-invalida-'));
    expect(m?.attributes.reason).toBe('INVALID_MESSAGE');
    expect((await walletState(w.id)).balance).toBe('100.00');
  });

  test('falha transitória: volta para a fila; esgotadas as tentativas, a SQS move para a DLQ', async () => {
    await consumirTudo();
    const w = await createWallet(t.url, '100.00');
    const env = await sendWagerMessage(wager(w, 'BET', '1.00'), 'msg-transitoria-' + crypto.randomUUID());
    // banco "com lock timeout" o tempo todo
    const sempreFalha = { execute: async () => Promise.reject(Object.assign(new Error('lock timeout simulado'), { code: '55P03' })) };
    const instavel = new WagerConsumer(sqs, sempreFalha as unknown as ProcessWager, t.app.get(UnitOfWork));
    let entregas = 0;
    for (let i = 0; i < 6; i++) {
      const lote = await sqs.receive(sinal);
      entregas += lote.length;
      if (lote.length) await instavel.processBatch(lote);
    }
    expect(entregas).toBe(config.sqs.maxReceiveCount);
    const dlq = await drainQueue(config.sqs.deadLetterQueue, corpos => corpos.some(c => c.includes(env.messageId)));
    expect(dlq.some(m => m.body.includes(env.messageId))).toBe(true);
    expect((await walletState(w.id)).balance).toBe('100.00');
  });
});

describe('outbox', () => {
  test('eventos gravados na transação chegam à fila de eventos e ficam marcados como publicados', async () => {
    const w = await createWallet(t.url, '100.00');
    const { body } = await submit(t.url, wager(w, 'BET', '5.00'));
    const publisher = t.app.get(OutboxPublisher);
    while ((await publisher.publishBatch()) > 0);
    const eventos = await drainQueue(config.sqs.eventsQueue, corpos => corpos.filter(c => c.includes(w.id)).length >= 3);
    const meus = eventos.map(e => JSON.parse(e.body)).filter(e => e.aggregateId === w.id);
    expect(meus.map(e => e.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged']);
    const mudanca = meus.find(e => e.eventType === 'WalletBalanceChanged' && e.data.transactionId === body.transactionId);
    expect(mudanca.data).toMatchObject({
      direction: 'DEBIT',
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '95.00', currency: 'BRL' },
      walletVersion: 2,
    });
    expect(mudanca.version).toBe(1);
    const pendentes = await db`select count(*)::int as n from outbox_messages where aggregate_id = ${w.id} and published_at is null`;
    expect(pendentes[0].n).toBe(0);
  });

  test('LOSS e rejeição publicam o evento da transação, mas não WalletBalanceChanged', async () => {
    const w = await createWallet(t.url, '1.00');
    await submit(t.url, wager(w, 'LOSS', '0.00'));
    await submit(t.url, wager(w, 'BET', '50.00'));
    const tipos = (await db`select event_type from outbox_messages where aggregate_id = ${w.id} order by seq`).map(
      (r: any) => r.event_type,
    );
    expect(tipos).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed', 'WagerTransactionRejected']);
  });
});
