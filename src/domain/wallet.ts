import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate root. Toda mudança de saldo passa por `debit`/`credit`, que devolvem o lançamento
 * correspondente: saldo e extrato não têm como andar separados.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Abre com o saldo inicial e version 1. O lançamento de abertura (OPENING) é montado pelo caso de uso. */
  static open(props: { id: string; playerId: string; initialBalance: Money; now: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new InvalidMoneyError('o saldo inicial não pode ser negativo');
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, props.now, props.now);
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    if (!this.canDebit(money)) throw new InsufficientFundsError();
    return this.move(LedgerDirection.Debit, money, transactionId, at);
  }

  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.move(LedgerDirection.Credit, money, transactionId, at);
  }

  apply(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(money, transactionId, at) : this.credit(money, transactionId, at);
  }

  // version só incrementa quando o saldo muda; o lançamento valida a própria aritmética.
  private move(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Debit ? before.subtract(money) : before.add(money);
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
