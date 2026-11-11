import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvalidLedgerEntryError } from '../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const agora = new Date('2026-11-10T12:00:00Z');
const abrir = (saldo = '100.00') => Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(saldo), now: agora });

describe('Wallet', () => {
  test('abre com o saldo inicial e version 1', () => {
    const w = abrir();
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(1);
    expect(w.currency).toBe('BRL');
  });

  test('débito tira do saldo, sobe a version e devolve o lançamento correspondente', () => {
    const w = abrir();
    const e = w.debit(brl('25.00'), 't1', agora);
    expect(w.balance.toString()).toBe('75.00');
    expect(w.version).toBe(2);
    expect(e.direction).toBe(LedgerDirection.Debit);
    expect([e.balanceBefore.toString(), e.money.toString(), e.balanceAfter.toString()]).toEqual(['100.00', '25.00', '75.00']);
    expect(e.isBalanced()).toBe(true);
  });

  test('débito sem saldo lança erro e não mexe em saldo nem version', () => {
    const w = abrir('20.00');
    expect(() => w.debit(brl('20.01'), 't1', agora)).toThrow(InsufficientFundsError);
    expect(w.balance.toString()).toBe('20.00');
    expect(w.version).toBe(1);
  });

  test('pode debitar exatamente o saldo, chegando a zero (nunca abaixo)', () => {
    const w = abrir('20.00');
    w.debit(brl('20.00'), 't1', agora);
    expect(w.balance.toString()).toBe('0.00');
  });

  test('crédito soma e também sobe a version', () => {
    const w = abrir();
    w.credit(brl('0.50'), 't1', agora);
    expect(w.balance.toString()).toBe('100.50');
    expect(w.version).toBe(2);
  });

  test('moeda da operação diferente da moeda da wallet', () => {
    const w = abrir();
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => w.credit(usd, 't1', agora)).toThrow(CurrencyMismatchError);
    expect(() => w.debit(usd, 't1', agora)).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });
});

describe('WalletLedgerEntry', () => {
  test('é congelado: não há como alterar um lançamento', () => {
    const e = abrir().debit(brl('1.00'), 't1', agora);
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as unknown as { money: Money }).money = brl('2.00');
    }).toThrow();
  });

  test('create confere a aritmética e recusa saldo final negativo ou valor zero', () => {
    const base = { walletId: 'w1', transactionId: 't1', createdAt: agora };
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('16.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});
