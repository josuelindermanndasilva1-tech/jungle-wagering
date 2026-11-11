import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createWallet, money, startApp, submit, type TestApp, wager, walletState } from '../support/infra';

// testes com banco, fila e processos de verdade: mais que os 5 s padrão do bun test
setDefaultTimeout(120_000);

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${t.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('wallets', () => {
  test('criar: saldo inicial vira OPENING + crédito no extrato, version 1', async () => {
    const w = await createWallet(t.url, '1000.00');
    const r: any = await (await fetch(`${t.url}/wallets/${w.id}`)).json();
    expect(r).toEqual({ id: w.id, playerId: w.playerId, balance: money('1000.00'), version: 1 });
    const extrato: any = await (await fetch(`${t.url}/wallets/${w.id}/ledger`)).json();
    expect(extrato.entries.map((e: any) => [e.direction, e.money.amount, e.balanceBefore.amount, e.balanceAfter.amount])).toEqual([
      ['CREDIT', '1000.00', '0.00', '1000.00'],
    ]);
  });

  test('saldo inicial zero não gera lançamento', async () => {
    const w = await createWallet(t.url, '0.00');
    expect(await walletState(w.id)).toMatchObject({ balance: '0.00', entries: 0, version: 1 });
  });

  test('duplicada para o mesmo player e moeda: 409; outra moeda pode', async () => {
    const w = await createWallet(t.url, '1.00');
    const dup = await post('/wallets', { playerId: w.playerId, initialBalance: money('5.00') });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as any).error.code).toBe('WALLET_ALREADY_EXISTS');
    expect((await post('/wallets', { playerId: w.playerId, initialBalance: money('5.00', 'USD') })).status).toBe(201);
  });

  test('payload inválido: 400 com os detalhes', async () => {
    const r = await post('/wallets', { playerId: 'x', initialBalance: { amount: 10, currency: 'BRL' } });
    expect(r.status).toBe(400);
    const corpo: any = await r.json();
    expect(corpo.error.code).toBe('INVALID_PAYLOAD');
    expect(corpo.error.details.length).toBe(2);
  });

  test('não encontrada: 404, inclusive com id que nem é UUID', async () => {
    expect((await fetch(`${t.url}/wallets/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await fetch(`${t.url}/wallets/nao-e-uuid`)).status).toBe(404);
  });

  test('extrato paginado com cursor estável e opaco', async () => {
    const w = await createWallet(t.url, '100.00');
    for (let i = 0; i < 5; i++) await submit(t.url, wager(w, 'BET', '1.00'));
    const vistos: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await (await fetch(`${t.url}/wallets/${w.id}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json();
      vistos.push(...r.entries.map((e: any) => e.balanceAfter.amount));
      cursor = r.nextCursor;
    } while (cursor);
    expect(vistos).toEqual(['100.00', '99.00', '98.00', '97.00', '96.00', '95.00']);
    expect((await fetch(`${t.url}/wallets/${w.id}/ledger?cursor=lixo`)).status).toBe(400);
    expect((await fetch(`${t.url}/wallets/${w.id}/ledger?limit=0`)).status).toBe(400);
  });

  test('reconciliação consistente', async () => {
    const w = await createWallet(t.url, '50.00');
    await submit(t.url, wager(w, 'BET', '20.00'));
    const r: any = await (await post(`/wallets/${w.id}/reconciliation`, {})).json();
    expect(r).toEqual({
      walletId: w.id,
      storedBalance: money('30.00'),
      calculatedBalance: money('30.00'),
      difference: money('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });
});

describe('POST /wagering/transactions', () => {
  test('status HTTP distintos: 200 processada, 422 regra de negócio, 202 pendente, 409 conflito, 400 inválido', async () => {
    const w = await createWallet(t.url, '10.00');
    const bet = wager(w, 'BET', '4.00');
    expect((await submit(t.url, bet)).status).toBe(200);
    const semSaldo = await submit(t.url, wager(w, 'BET', '50.00'));
    expect([semSaldo.status, semSaldo.body.status, semSaldo.body.failureCode, semSaldo.body.balance]).toEqual([
      422,
      'REJECTED',
      'INSUFFICIENT_FUNDS',
      money('6.00'),
    ]);
    expect((await submit(t.url, wager(w, 'REFUND', '4.00', { referenceExternalTransactionId: 'ainda-nao' }))).status).toBe(202);
    expect((await submit(t.url, { ...bet, money: money('5.00') })).status).toBe(409);
    expect((await submit(t.url, { ...bet, kind: 'OPENING' }, 'k-opening')).status).toBe(400);
  });

  test('replay devolve o resultado original, com o saldo daquele momento', async () => {
    const w = await createWallet(t.url, '100.00');
    const primeira = wager(w, 'BET', '25.00');
    const r1 = await submit(t.url, primeira);
    await submit(t.url, wager(w, 'BET', '10.00'));
    const r2 = await submit(t.url, primeira);
    expect(r2.status).toBe(r1.status);
    expect(r2.body).toEqual({ ...r1.body, idempotentReplay: true });
    expect(r2.body.balance).toEqual(money('75.00'));
    expect((await walletState(w.id)).balance).toBe('65.00');
  });

  test('o replay de uma rejeição também é idêntico', async () => {
    const w = await createWallet(t.url, '1.00');
    const b = wager(w, 'BET', '2.00');
    const r1 = await submit(t.url, b);
    const r2 = await submit(t.url, b);
    expect([r1.status, r2.status]).toEqual([422, 422]);
    expect(r2.body).toEqual({ ...r1.body, idempotentReplay: true });
  });

  test('mesmo externalTransactionId com outra chave: 409 EXTERNAL_ID_CONFLICT', async () => {
    const w = await createWallet(t.url, '10.00');
    const b = wager(w, 'BET', '1.00');
    await submit(t.url, b);
    const r = await submit(t.url, b, 'outra-chave-' + crypto.randomUUID());
    expect([r.status, r.body.error.code]).toEqual([409, 'EXTERNAL_ID_CONFLICT']);
  });

  test('Idempotency-Key ausente: 400', async () => {
    const w = await createWallet(t.url, '10.00');
    const r = await post('/wagering/transactions', wager(w, 'BET', '1.00'));
    expect(r.status).toBe(400);
  });

  test('consultas por id interno e por (provider, id externo)', async () => {
    const w = await createWallet(t.url, '10.00');
    const b = wager(w, 'BET', '3.00');
    const { body } = await submit(t.url, b);
    const porId: any = await (await fetch(`${t.url}/wagering/transactions/${body.transactionId}`)).json();
    const porExterno: any = await (
      await fetch(`${t.url}/providers/${b.providerId}/wagering/transactions/${b.externalTransactionId}`)
    ).json();
    expect(porId).toEqual(porExterno);
    expect(porId).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: money('3.00'), balance: money('7.00'), walletId: w.id });
    expect((await fetch(`${t.url}/providers/x/wagering/transactions/nao-existe`)).status).toBe(404);
  });

  test('correlationId: o recebido volta na resposta', async () => {
    const r = await fetch(`${t.url}/health/live`, { headers: { 'x-correlation-id': 'corr-123' } });
    expect(r.headers.get('x-correlation-id')).toBe('corr-123');
  });
});

describe('operação', () => {
  test('health: live e ready, sem autenticação', async () => {
    expect(await (await fetch(`${t.url}/health/live`)).json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${t.url}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('métricas no formato do Prometheus', async () => {
    const texto = await (await fetch(`${t.url}/metrics`)).text();
    for (const nome of [
      'wagering_transactions_total',
      'wagering_duplicates_total',
      'wagering_retries_total',
      'wagering_dlq_messages_total',
      'wagering_lock_conflicts_total',
      'wagering_outbox_lag_seconds',
      'wagering_processing_duration_seconds',
    ]) {
      expect(texto).toContain(nome);
    }
  });
});
