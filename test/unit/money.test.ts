import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('escala fixa de 2 casas na saída, com ou sem casas na entrada', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('25.50').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(brl('0').toString()).toBe('0.00');
    expect(brl('9999999999999999.99').toString()).toBe('9999999999999999.99');
  });

  test('aritmética exata: 0.10 + 0.20 é 0.30, sem erro de ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).subtract(brl('80.00')).toString()).toBe('-60.00');
    expect(brl('100.00').subtract(brl('80.00')).subtract(brl('80.00')).isNegative()).toBe(true);
    expect(brl('12.34').negate().toString()).toBe('-12.34');
  });

  test('não arredonda: mais de 2 casas é recusado, não cortado', () => {
    expect(() => brl('10.005')).toThrow(InvalidMoneyError);
    expect(() => brl('0.001')).toThrow(InvalidMoneyError);
  });

  test.each([
    [''],
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e3'],
    ['1E-2'],
    ['-1.00'],
    [' 1.00'],
    ['1.00 '],
    ['01.00'],
    ['1.'],
    ['.5'],
    ['1,50'],
    ['+1'],
  ])('recusa amount inválido %p', amount => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('recusa amount que não é string e moeda fora do padrão ISO-4217', () => {
    expect(() => Money.from({ amount: 25 as never, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: NaN as never, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'REAL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from(null as never)).toThrow(InvalidMoneyError);
  });

  test('operações entre moedas diferentes lançam erro de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  test('é imutável: cada operação devolve uma instância nova', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('15.00');
    expect(b).not.toBe(a);
  });

  test('comparações', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80').equals(brl('80.00'))).toBe(true);
  });

  test('fromPersisted aceita o sinal vindo do banco (somas de conferência)', () => {
    expect(Money.fromPersisted('-5.00', 'BRL').toString()).toBe('-5.00');
    expect(Money.fromPersisted('5.00', 'BRL').toString()).toBe('5.00');
  });
});
