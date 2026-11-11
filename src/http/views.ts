import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { Wallet } from '../domain/wallet';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';

// Formato das respostas: dinheiro sempre como { amount: "25.00", currency: "BRL" }.

export const walletView = (w: Wallet) => ({
  id: w.id,
  playerId: w.playerId,
  balance: w.balance.toJSON(),
  version: w.version,
});

export const ledgerEntryView = (e: WalletLedgerEntry) => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  createdAt: e.createdAt.toISOString(),
});

export const transactionView = (t: WagerTransaction) => ({
  transactionId: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  money: t.money.toJSON(),
  referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
  referenceTransactionId: t.referenceTransactionId ?? null,
  status: t.status,
  failureCode: t.failureCode ?? null,
  balance: t.observedBalance?.toJSON() ?? null,
  createdAt: t.createdAt.toISOString(),
  processedAt: t.processedAt?.toISOString() ?? null,
});

/** Resposta do POST /wagering/transactions; o replay devolve o mesmo corpo com idempotentReplay: true. */
export const wagerResultView = (t: WagerTransaction, idempotentReplay: boolean) => ({
  transactionId: t.id,
  status: t.status,
  balance: t.observedBalance?.toJSON() ?? null,
  ...(t.failureCode ? { failureCode: t.failureCode } : {}),
  idempotentReplay,
});

/** PROCESSED 200 · PENDING_REFERENCE 202 (aceita, aguardando a referência) · REJECTED 422 (regra de negócio) · FAILED 500. */
export function httpStatusFor(t: WagerTransaction): number {
  switch (t.status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
    default:
      return 202;
  }
}
