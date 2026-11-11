import { CurrencyMismatchError, InvalidMoneyError } from './errors';

// DTO — interface é adequada aqui
export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217
}

// Até 16 dígitos inteiros e 2 casas: cabe exatamente em NUMERIC(18,2).
// Recusa vazio, sinal, notação científica, NaN, Infinity, zeros à esquerda e mais de 2 casas.
const AMOUNT = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável. Guarda centavos em `bigint`: aritmética inteira e exata, sem `number`.
 * Valores negativos só nascem de operações internas (subtract, negate); nunca de um contrato de entrada.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {}

  /** Contrato de entrada: string decimal não negativa, com no máximo 2 casas. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') throw new InvalidMoneyError('money deve ser um objeto { amount, currency }');
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !AMOUNT.test(amount)) {
      throw new InvalidMoneyError(`amount inválido: ${JSON.stringify(amount)}; use string decimal não negativa com até 2 casas`);
    }
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError(`currency inválida: ${JSON.stringify(currency)}; use o código ISO-4217, ex.: BRL`);
    }
    const [inteiro, decimal = ''] = amount.split('.');
    return new Money(BigInt(inteiro) * 100n + BigInt(decimal.padEnd(2, '0')), currency);
  }

  /** Valor vindo do próprio banco, já validado na entrada. Aceita sinal: somas de conferência podem dar negativo. */
  static fromPersisted(amount: string, currency: string): Money {
    const negativo = amount.startsWith('-');
    const valor = Money.from({ amount: negativo ? amount.slice(1) : amount, currency });
    return negativo ? valor.negate() : valor;
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Sempre com escala fixa de 2 casas: "25.00", "-0.50". */
  toString(): string {
    const negativo = this.cents < 0n;
    const abs = negativo ? -this.cents : this.cents;
    const texto = `${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
    return negativo ? `-${texto}` : texto;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
