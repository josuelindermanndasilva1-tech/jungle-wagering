import { FailureCode } from './failure-codes';
import { LedgerDirection, type WalletLedgerEntry } from './ledger-entry';
import type { Wallet } from './wallet';
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

export interface SettlementPolicy {
  /** Espera da primeira nova tentativa de achar a referência; dobra a cada tentativa. */
  referenceBaseDelayMs: number;
  /** Depois de tantas tentativas sem referência, a transação vira REJECTED / REFERENCE_NOT_FOUND. */
  maxReferenceAttempts: number;
}

export interface SettlementInput {
  transaction: WagerTransaction;
  /** A wallet já travada pelo chamador (SELECT ... FOR UPDATE), ou undefined se não existe. */
  wallet: Wallet | undefined;
  /** A transação apontada por (providerId, referenceExternalTransactionId), se houver e se já chegou. */
  reference: WagerTransaction | undefined;
  /** Já existe REFUND ou ROLLBACK processado para essa referência? */
  referenceAlreadyReversed: boolean;
  now: Date;
  policy: SettlementPolicy;
}

export type SettlementOutcome =
  { type: 'processed'; entry?: WalletLedgerEntry } | { type: 'rejected'; code: FailureCode } | { type: 'pending-reference' };

/**
 * As regras de negócio da tabela da seção 7, num lugar só e sem banco: decide o destino da transação
 * e aplica a movimentação na wallet. O chamador só persiste o que mudou.
 */
export function settle(i: SettlementInput): SettlementOutcome {
  const { transaction: tx, wallet, reference: ref, now } = i;
  const reject = (code: FailureCode, mostrarSaldo = true): SettlementOutcome => {
    tx.reject(code, now, mostrarSaldo ? wallet?.balance : undefined);
    return { type: 'rejected', code };
  };

  if (!wallet) return reject(FailureCode.WalletNotFound);
  // a wallet é de outro player: não devolvemos o saldo dela
  if (wallet.playerId !== tx.playerId) return reject(FailureCode.WalletPlayerMismatch, false);
  if (wallet.currency !== tx.money.currency) return reject(FailureCode.CurrencyMismatch);

  if (tx.referenceExternalTransactionId) {
    // referência ausente, ou ainda esperando a dela: aguarda e tenta de novo mais tarde
    if (!ref || !ref.isTerminal()) {
      if (tx.referenceAttempts >= i.policy.maxReferenceAttempts) return reject(FailureCode.ReferenceNotFound);
      tx.markPendingReference(now, i.policy.referenceBaseDelayMs);
      return { type: 'pending-reference' };
    }
    if (ref.status !== WagerTransactionStatus.Processed) return reject(FailureCode.ReferenceNotProcessed);
    const mesmaOrigem =
      ref.providerId === tx.providerId &&
      ref.playerId === tx.playerId &&
      ref.walletId === tx.walletId &&
      ref.money.currency === tx.money.currency &&
      ref.roundId === tx.roundId;
    if (!mesmaOrigem) return reject(FailureCode.ReferenceMismatch);
    if (!tx.acceptsReferenceOfKind(ref.kind)) return reject(FailureCode.InvalidReferenceKind);
    if (tx.isReversal()) {
      if (!ref.money.equals(tx.money)) return reject(FailureCode.AmountMismatch);
      if (i.referenceAlreadyReversed) return reject(FailureCode.AlreadyReversed);
    }
  }

  // LOSS registra o resultado sem mover saldo e sem lançamento
  if (!tx.affectsBalance()) {
    tx.markProcessed(ref?.id, now, wallet.balance);
    return { type: 'processed' };
  }

  const direction = tx.ledgerDirectionFor(ref);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    // reverter um crédito já gasto é diferente de apostar sem saldo: códigos distintos
    return reject(tx.kind === WagerTransactionKind.Rollback ? FailureCode.RollbackInsufficientFunds : FailureCode.InsufficientFunds);
  }
  const entry = wallet.apply(direction, tx.money, tx.id, now);
  tx.markProcessed(ref?.id, now, wallet.balance);
  return { type: 'processed', entry };
}
