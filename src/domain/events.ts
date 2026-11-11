import { newId } from './ids';
import type { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import type { MoneyProps } from './money';
import type { Wallet } from './wallet';
import type { WagerTransaction } from './wager-transaction';

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

export interface IntegrationEventProps<T> extends EventContext {
  eventId: string;
  aggregateId: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventJson<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  version: number;
  data: T;
}

/** Envelope dos eventos de integração. O tipo e a versão ficam na subclasse, não no ponto de chamada. */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  /** Envelope serializado gravado no payload da outbox. */
  toJSON(): IntegrationEventJson<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

// O aggregateId de todos os eventos é a wallet: é a unidade de consistência e o MessageGroupId na fila FIFO.
const envelope = <T>(tx: { walletId: string }, ctx: EventContext, at: Date, data: T): IntegrationEventProps<T> => ({
  eventId: newId(),
  aggregateId: tx.walletId,
  correlationId: ctx.correlationId,
  causationId: ctx.causationId,
  occurredAt: at,
  data,
});

const resumo = (tx: WagerTransaction) => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
});

export interface WagerTransactionProcessedData extends ReturnType<typeof resumo> {
  referenceTransactionId?: string;
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext, at: Date): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      envelope(tx, ctx, at, { ...resumo(tx), referenceTransactionId: tx.referenceTransactionId, balance: tx.observedBalance!.toJSON() }),
    );
  }
}

export interface WagerTransactionRejectedData extends ReturnType<typeof resumo> {
  failureCode: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext, at: Date): WagerTransactionRejected {
    return new WagerTransactionRejected(envelope(tx, ctx, at, { ...resumo(tx), failureCode: tx.failureCode! }));
  }
}

export interface WagerTransactionPendingReferenceData extends ReturnType<typeof resumo> {
  referenceExternalTransactionId: string;
  attempt: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext, at: Date): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      envelope(tx, ctx, at, {
        ...resumo(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId!,
        attempt: tx.referenceAttempts,
        nextAttemptAt: tx.nextAttemptAt!.toISOString(),
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      envelope({ walletId: wallet.id }, ctx, entry.createdAt, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}
