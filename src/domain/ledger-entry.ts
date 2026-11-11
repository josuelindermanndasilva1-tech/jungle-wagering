import { InvalidLedgerEntryError } from './errors';
import { newId } from './ids';
import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = Omit<LedgerEntryState, 'id' | 'createdAt'> & { createdAt: Date };

/**
 * Lançamento do extrato. Sem campos mutáveis e sem métodos de transição: a instância é congelada.
 * O banco reforça a mesma regra (trigger que recusa UPDATE e DELETE).
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Valida a aritmética: balanceBefore ± money === balanceAfter, valor positivo, saldo final não negativo. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) throw new InvalidLedgerEntryError('o valor do lançamento deve ser positivo');
    if (props.balanceAfter.isNegative()) throw new InvalidLedgerEntryError('o lançamento deixaria o saldo negativo');
    const entry = new WalletLedgerEntry(
      newId(),
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
    if (!entry.isBalanced()) throw new InvalidLedgerEntryError('saldo antes ± valor não bate com o saldo depois');
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const esperado =
      this.direction === LedgerDirection.Credit ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return esperado.equals(this.balanceAfter);
  }
}
