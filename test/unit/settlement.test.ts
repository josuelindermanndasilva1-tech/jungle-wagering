import { describe, expect, test } from 'bun:test';
import { InvalidTransactionError, InvalidTransactionStateError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-codes';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { settle, type SettlementInput } from '../../src/domain/settlement';
import { Wallet } from '../../src/domain/wallet';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/domain/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const agora = new Date('2026-11-10T12:00:00Z');
const politica = { referenceBaseDelayMs: 1000, maxReferenceAttempts: 3 };
let seq = 0;

const carteira = (saldo = '100.00', playerId = 'p1') => Wallet.open({ id: 'w1', playerId, initialBalance: brl(saldo), now: agora });

function transacao(kind: K, amount: string, extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  seq++;
  return WagerTransaction.create({
    id: `id-${seq}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    payloadHash: 'h',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: brl(amount),
    createdAt: agora,
    ...extra,
  });
}

/** Liquida e devolve o resultado; cada teste confere status, código, saldo e lançamento. */
function liquidar(tx: WagerTransaction, wallet: Wallet | undefined, extra: Partial<SettlementInput> = {}) {
  return settle({ transaction: tx, wallet, reference: undefined, referenceAlreadyReversed: false, now: agora, policy: politica, ...extra });
}

/** Uma transação já processada contra a wallet, para servir de referência. */
function processada(kind: K, amount: string, wallet: Wallet, extra = {}) {
  const tx = transacao(kind, amount, extra);
  expect(liquidar(tx, wallet).type).toBe('processed');
  return tx;
}

describe('BET', () => {
  test('debita, gera um lançamento DEBIT e fica PROCESSED com o saldo observado', () => {
    const w = carteira();
    const tx = transacao(K.Bet, '25.00');
    const r = liquidar(tx, w);
    expect(r.type).toBe('processed');
    expect(r.type === 'processed' && r.entry?.direction).toBe(LedgerDirection.Debit);
    expect(tx.status).toBe(S.Processed);
    expect(tx.observedBalance?.toString()).toBe('75.00');
    expect(w.balance.toString()).toBe('75.00');
  });

  test('sem saldo: REJECTED com INSUFFICIENT_FUNDS, sem lançamento e sem mexer na wallet', () => {
    const w = carteira('10.00');
    const tx = transacao(K.Bet, '10.01');
    expect(liquidar(tx, w)).toEqual({ type: 'rejected', code: FailureCode.InsufficientFunds });
    expect([tx.status, w.balance.toString(), w.version]).toEqual([S.Rejected, '10.00', 1]);
  });

  test('BET não referencia outra transação', () => {
    expect(() => transacao(K.Bet, '1.00', { referenceExternalTransactionId: 'x' })).toThrow(InvalidTransactionError);
  });
});

describe('WIN', () => {
  test('credita, com ou sem referência à BET da rodada', () => {
    const w = carteira();
    const bet = processada(K.Bet, '10.00', w);
    const win = transacao(K.Win, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const r = liquidar(win, w, { reference: bet });
    expect(r.type === 'processed' && r.entry?.direction).toBe(LedgerDirection.Credit);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(w.balance.toString()).toBe('120.00');
  });

  test('referência de outra rodada: REFERENCE_MISMATCH', () => {
    const w = carteira();
    const bet = processada(K.Bet, '10.00', w, { roundId: 'r-outra' });
    const win = transacao(K.Win, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(liquidar(win, w, { reference: bet })).toEqual({ type: 'rejected', code: FailureCode.ReferenceMismatch });
  });
});

describe('LOSS', () => {
  test('registra o resultado sem mover saldo, sem lançamento e sem subir a version', () => {
    const w = carteira();
    const tx = transacao(K.Loss, '0.00');
    expect(liquidar(tx, w)).toEqual({ type: 'processed' });
    expect([tx.status, w.balance.toString(), w.version, tx.affectsBalance()]).toEqual([S.Processed, '100.00', 1, false]);
  });
});

describe('REFUND', () => {
  test('credita o valor da BET de volta', () => {
    const w = carteira();
    const bet = processada(K.Bet, '40.00', w);
    const refund = transacao(K.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(liquidar(refund, w, { reference: bet }).type).toBe('processed');
    expect(w.balance.toString()).toBe('100.00');
  });

  test('exige referência', () => {
    expect(() => transacao(K.Refund, '1.00')).toThrow(InvalidTransactionError);
  });

  test('só reverte BET: REFUND de um WIN é INVALID_REFERENCE_KIND', () => {
    const w = carteira();
    const win = processada(K.Win, '5.00', w);
    const refund = transacao(K.Refund, '5.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(liquidar(refund, w, { reference: win })).toEqual({ type: 'rejected', code: FailureCode.InvalidReferenceKind });
  });

  test('valor diferente da referência: AMOUNT_MISMATCH (reversão parcial fora do escopo)', () => {
    const w = carteira();
    const bet = processada(K.Bet, '40.00', w);
    const refund = transacao(K.Refund, '39.99', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(liquidar(refund, w, { reference: bet })).toEqual({ type: 'rejected', code: FailureCode.AmountMismatch });
  });

  test('uma vez só: a segunda é ALREADY_REVERSED', () => {
    const w = carteira();
    const bet = processada(K.Bet, '40.00', w);
    const refund = transacao(K.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(liquidar(refund, w, { reference: bet, referenceAlreadyReversed: true })).toEqual({
      type: 'rejected',
      code: FailureCode.AlreadyReversed,
    });
    expect(w.balance.toString()).toBe('60.00');
  });

  test('referência rejeitada não tem o que reverter: REFERENCE_NOT_PROCESSED', () => {
    const w = carteira('1.00');
    const bet = transacao(K.Bet, '40.00');
    liquidar(bet, w);
    const refund = transacao(K.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(liquidar(refund, w, { reference: bet })).toEqual({ type: 'rejected', code: FailureCode.ReferenceNotProcessed });
  });
});

describe('ROLLBACK', () => {
  test('de uma BET credita; de um WIN debita', () => {
    const w = carteira();
    const bet = processada(K.Bet, '10.00', w);
    const rb1 = transacao(K.Rollback, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const r1 = liquidar(rb1, w, { reference: bet });
    expect(r1.type === 'processed' && r1.entry?.direction).toBe(LedgerDirection.Credit);
    const win = processada(K.Win, '50.00', w);
    const rb2 = transacao(K.Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });
    const r2 = liquidar(rb2, w, { reference: win });
    expect(r2.type === 'processed' && r2.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('de um REFUND debita de novo', () => {
    const w = carteira();
    const bet = processada(K.Bet, '10.00', w);
    const refund = transacao(K.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(liquidar(refund, w, { reference: bet }).type).toBe('processed');
    const rb = transacao(K.Rollback, '10.00', { referenceExternalTransactionId: refund.externalTransactionId });
    expect(liquidar(rb, w, { reference: refund }).type).toBe('processed');
    expect(w.balance.toString()).toBe('90.00');
  });

  test('ROLLBACK de um WIN já gasto: ROLLBACK_INSUFFICIENT_FUNDS, código diferente de aposta sem saldo', () => {
    const w = carteira('0.00');
    const win = processada(K.Win, '50.00', w);
    processada(K.Bet, '45.00', w);
    const rb = transacao(K.Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(liquidar(rb, w, { reference: win })).toEqual({ type: 'rejected', code: FailureCode.RollbackInsufficientFunds });
    expect(FailureCode.RollbackInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(w.balance.toString()).toBe('5.00');
  });

  test('ROLLBACK não referencia LOSS', () => {
    const w = carteira();
    const loss = processada(K.Loss, '0.00', w);
    const rb = transacao(K.Rollback, '1.00', { referenceExternalTransactionId: loss.externalTransactionId });
    expect(liquidar(rb, w, { reference: loss })).toEqual({ type: 'rejected', code: FailureCode.InvalidReferenceKind });
  });
});

describe('referência fora de ordem', () => {
  test('referência ausente: PENDING_REFERENCE com backoff exponencial, depois REFERENCE_NOT_FOUND', () => {
    const w = carteira();
    const refund = transacao(K.Refund, '10.00', { referenceExternalTransactionId: 'ainda-nao-chegou' });
    const esperas: number[] = [];
    for (let i = 0; i < politica.maxReferenceAttempts; i++) {
      expect(liquidar(refund, w)).toEqual({ type: 'pending-reference' });
      esperas.push(refund.nextAttemptAt!.getTime() - agora.getTime());
    }
    expect(esperas).toEqual([1000, 2000, 4000]);
    expect(liquidar(refund, w)).toEqual({ type: 'rejected', code: FailureCode.ReferenceNotFound });
    expect(w.balance.toString()).toBe('100.00');
  });

  test('referência que ainda está esperando a dela: continua pendente', () => {
    const w = carteira();
    const win = transacao(K.Win, '5.00', { referenceExternalTransactionId: 'bet-futura' });
    liquidar(win, w);
    const rb = transacao(K.Rollback, '5.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(liquidar(rb, w, { reference: win })).toEqual({ type: 'pending-reference' });
  });
});

describe('wallet e moeda', () => {
  test('conflito de moeda: CURRENCY_MISMATCH', () => {
    const w = carteira();
    const tx = transacao(K.Bet, '1.00', { money: Money.from({ amount: '1.00', currency: 'USD' }) });
    expect(liquidar(tx, w)).toEqual({ type: 'rejected', code: FailureCode.CurrencyMismatch });
  });

  test('wallet de outro player: WALLET_PLAYER_MISMATCH, sem revelar o saldo dela', () => {
    const tx = transacao(K.Bet, '1.00');
    expect(liquidar(tx, carteira('100.00', 'outro'))).toEqual({ type: 'rejected', code: FailureCode.WalletPlayerMismatch });
    expect(tx.observedBalance).toBeUndefined();
  });

  test('wallet inexistente: WALLET_NOT_FOUND', () => {
    expect(liquidar(transacao(K.Bet, '1.00'), undefined)).toEqual({ type: 'rejected', code: FailureCode.WalletNotFound });
  });
});

describe('estados', () => {
  test('PROCESSED, REJECTED e FAILED são terminais', () => {
    const w = carteira();
    const tx = processada(K.Bet, '1.00', w);
    expect(() => tx.reject(FailureCode.InsufficientFunds, agora)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(agora, 1)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InternalError, agora)).toThrow(InvalidTransactionStateError);
    const rej = transacao(K.Bet, '1000.00');
    liquidar(rej, w);
    expect(() => rej.markProcessed(undefined, agora, brl('1.00'))).toThrow(InvalidTransactionStateError);
  });

  test('OPENING é interno: create recusa', () => {
    expect(() => transacao(K.Opening, '1.00')).toThrow(InvalidTransactionError);
  });

  test('valor zero só é aceito em LOSS', () => {
    expect(() => transacao(K.Bet, '0.00')).toThrow(InvalidTransactionError);
    expect(() => transacao(K.Win, '0.00')).toThrow(InvalidTransactionError);
    expect(() => transacao(K.Loss, '0.00')).not.toThrow();
  });
});
