import { InvalidTransactionError, InvalidTransactionStateError } from './errors';
import type { FailureCode } from './failure-codes';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violação de regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal, auditável)
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id no provedor — não o id interno */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Saldo observado quando a transação terminou: é o que o replay devolve. */
  observedBalance?: Money;
  referenceAttempts: number;
  nextAttemptAt?: Date;
}

const TERMINAIS = new Set([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed]);

// Que tipo cada operação pode referenciar. WIN e LOSS podem apontar a BET da rodada; BET não referencia nada.
const REFERENCIAS_PERMITIDAS: Record<WagerTransactionKind, WagerTransactionKind[]> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

/**
 * Transições válidas:
 *   PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa agendada)
 *   PROCESSED, REJECTED e FAILED são terminais: qualquer transição a partir deles é erro de programação.
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _referenceAttempts = 0,
    private _nextAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. OPENING não entra por aqui. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) throw new InvalidTransactionError('OPENING é interno e não pode ser submetido');
    return WagerTransaction.build(props);
  }

  /** Crédito de abertura da wallet, criado junto com ela. */
  static opening(props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>): WagerTransaction {
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening });
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.observedBalance,
      s.referenceAttempts,
      s.nextAttemptAt,
    );
  }

  private static build(p: CreateWagerTransactionProps): WagerTransaction {
    const precisa = p.kind === WagerTransactionKind.Refund || p.kind === WagerTransactionKind.Rollback;
    if (precisa && !p.referenceExternalTransactionId) throw new InvalidTransactionError(`${p.kind} exige referenceExternalTransactionId`);
    if (p.referenceExternalTransactionId && REFERENCIAS_PERMITIDAS[p.kind].length === 0) {
      throw new InvalidTransactionError(`${p.kind} não referencia outra transação`);
    }
    if (p.kind === WagerTransactionKind.Loss ? p.money.isNegative() : !p.money.isPositive()) {
      throw new InvalidTransactionError(`${p.kind} exige valor ${p.kind === WagerTransactionKind.Loss ? 'não negativo' : 'positivo'}`);
    }
    return new WagerTransaction(
      p.id,
      p.providerId,
      p.externalTransactionId,
      p.idempotencyKey,
      p.payloadHash,
      p.walletId,
      p.playerId,
      p.roundId,
      p.gameId,
      p.kind,
      p.money,
      p.referenceExternalTransactionId,
      p.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)
  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
  }

  /** Agenda a próxima busca da referência com backoff exponencial: base, 2×base, 4×base... */
  markPendingReference(now: Date, baseDelayMs: number): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = new Date(now.getTime() + baseDelayMs * 2 ** this._referenceAttempts);
    this._referenceAttempts += 1;
  }

  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  // ---- consultas de domínio
  isTerminal(): boolean {
    return TERMINAIS.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  acceptsReferenceOfKind(kind: WagerTransactionKind): boolean {
    return REFERENCIAS_PERMITIDAS[this.kind].includes(kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** BET debita; WIN, REFUND e OPENING creditam; ROLLBACK faz o inverso da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === WagerTransactionKind.Rollback) {
      if (!reference) throw new InvalidTransactionError('ROLLBACK precisa da referência para saber a direção');
      return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
    }
    return this.kind === WagerTransactionKind.Bet ? LedgerDirection.Debit : LedgerDirection.Credit;
  }

  private assertNotTerminal(to: WagerTransactionStatus): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this._status, to);
  }
}
