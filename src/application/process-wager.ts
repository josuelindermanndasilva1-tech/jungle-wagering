import { Injectable } from '@nestjs/common';
import { config } from '../config';
import {
  type EventContext,
  type IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events';
import { FailureCode } from '../domain/failure-codes';
import { newId } from '../domain/ids';
import { InboxMessage, OutboxMessage } from '../domain/messaging';
import type { Money } from '../domain/money';
import { payloadHash } from '../domain/payload-hash';
import { settle, type SettlementPolicy } from '../domain/settlement';
import { WagerTransaction, type WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { log } from '../infrastructure/observability/logger';
import { metrics } from '../infrastructure/observability/metrics';
import { ConflictError } from './errors';
import { type Repositories, UnitOfWork } from './ports';

export interface WagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface WagerContext extends EventContext {
  source: 'http' | 'sqs';
  /** Presente quando a entrada é a fila: a mensagem entra na inbox na mesma transação. */
  inbox?: InboxContext;
}

export type WagerResult =
  | { type: 'settled'; transaction: WagerTransaction; idempotentReplay: boolean }
  /** A mensagem já tinha sido processada (redelivery): nada a fazer além do ack. */
  | { type: 'duplicate-message' };

/**
 * O hash do pedido: JSON canônico só dos campos de negócio. A Idempotency-Key e os metadados de transporte
 * (messageId, occurredAt, correlationId) ficam de fora; "25.5" e "25.50" são o mesmo valor.
 */
export function wagerPayloadHash(c: WagerCommand): string {
  return payloadHash({
    providerId: c.providerId,
    externalTransactionId: c.externalTransactionId,
    playerId: c.playerId,
    walletId: c.walletId,
    roundId: c.roundId,
    gameId: c.gameId,
    kind: c.kind,
    money: c.money.toJSON(),
    referenceExternalTransactionId: c.referenceExternalTransactionId,
  });
}

const politica = (): SettlementPolicy => ({
  referenceBaseDelayMs: config.pending.baseDelayMs,
  maxReferenceAttempts: config.pending.maxAttempts,
});

/**
 * O caso de uso central, igual para a API, para a fila e para o worker de referências pendentes.
 * Dentro de uma transação SQL: inbox, registro da transação, trava da wallet, regras, saldo, extrato e outbox.
 */
@Injectable()
export class ProcessWager {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(cmd: WagerCommand, ctx: WagerContext): Promise<WagerResult> {
    const fim = metrics.processing.startTimer({ source: ctx.source });
    const agora = new Date();
    const hash = wagerPayloadHash(cmd);
    // valida o pedido antes de abrir a transação (ex.: REFUND sem referência lança erro de domínio)
    const nova = WagerTransaction.create({ id: newId(), ...cmd, payloadHash: hash, createdAt: agora });
    try {
      const resultado = await this.uow.run(async (r): Promise<WagerResult> => {
        const inbox = ctx.inbox && InboxMessage.receive({ ...ctx.inbox, receivedAt: agora });
        if (inbox) {
          const vista = await r.inbox.receive(inbox);
          if (vista) {
            if (vista.payloadHash !== inbox.payloadHash)
              throw new ConflictError('MESSAGE_ID_CONFLICT', 'messageId repetido com outro conteúdo');
            return { type: 'duplicate-message' };
          }
        }

        let resultado: WagerResult;
        if (await r.transactions.insertIfAbsent(nova, ctx.correlationId)) {
          await this.settleAndRecord(r, nova, ctx, agora);
          resultado = { type: 'settled', transaction: nova, idempotentReplay: false };
        } else {
          resultado = { type: 'settled', transaction: await this.original(r, cmd, hash), idempotentReplay: true };
        }

        if (inbox) {
          inbox.markProcessed(agora);
          await r.inbox.save(inbox);
        }
        return resultado;
      });
      this.registrar(resultado, ctx.correlationId, ctx.inbox?.messageId);
      if (resultado.type === 'settled' && !resultado.idempotentReplay) await this.acordarPendentes(resultado.transaction);
      return resultado;
    } finally {
      fim();
    }
  }

  /**
   * Reprocessa as PENDING_REFERENCE vencidas. Cada uma numa transação própria; outra instância que tente
   * a mesma pula a linha (SKIP LOCKED). Devolve quantas foram tratadas.
   */
  async retryDuePending(limite = 20): Promise<number> {
    const ids = await this.uow.read(r => r.transactions.findDuePendingIds(new Date(), limite));
    let tratadas = 0;
    for (const id of ids) {
      try {
        const tx = await this.uow.run(async r => {
          const agora = new Date();
          const guardada = await r.transactions.lockDuePending(id, agora);
          if (!guardada) return undefined;
          await this.settleAndRecord(r, guardada.transaction, { correlationId: guardada.correlationId, causationId: id }, agora);
          return guardada.transaction;
        });
        if (!tx) continue;
        await this.acordarPendentes(tx);
        tratadas++;
        metrics.retries.inc({ source: 'pending-reference' });
        this.registrar({ type: 'settled', transaction: tx, idempotentReplay: false }, id);
      } catch (e) {
        if (this.uow.isTransient(e)) throw e;
        await this.marcarFalha(id, e);
      }
    }
    return tratadas;
  }

  /** Mesma chave: devolve o resultado original, ou conflito se o pedido não é o mesmo. */
  private async original(r: Repositories, cmd: WagerCommand, hash: string): Promise<WagerTransaction> {
    const existente = await r.transactions.findByIdempotencyKey(cmd.idempotencyKey);
    // o insert bateu na unicidade de (providerId, externalTransactionId), sob outra chave
    if (!existente) throw new ConflictError('EXTERNAL_ID_CONFLICT', 'externalTransactionId já registrado com outra Idempotency-Key');
    if (!existente.matchesPayload(hash)) throw new ConflictError('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key já usada com outro payload');
    return existente;
  }

  private async settleAndRecord(r: Repositories, tx: WagerTransaction, ctx: EventContext, agora: Date): Promise<void> {
    // a trava da wallet serializa tudo o que mexe nela, inclusive a checagem de "já revertida"
    const wallet = await r.wallets.findForUpdate(tx.walletId);
    const versionAntes = wallet?.version ?? 0;
    const referencia = tx.referenceExternalTransactionId
      ? await r.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
    const jaRevertida =
      !!referencia &&
      tx.isReversal() &&
      referencia.status === WagerTransactionStatus.Processed &&
      (await r.transactions.hasProcessedReversal(referencia.id));

    const resultado = settle({
      transaction: tx,
      wallet,
      reference: referencia,
      referenceAlreadyReversed: jaRevertida,
      now: agora,
      policy: politica(),
    });

    const eventos: IntegrationEvent<unknown>[] = [];
    await r.transactions.save(tx);
    if (resultado.type === 'processed') {
      if (resultado.entry) {
        await r.wallets.saveBalance(wallet!, versionAntes);
        await r.ledger.insert(resultado.entry);
      }
      eventos.push(WagerTransactionProcessed.from(tx, ctx, agora));
      if (resultado.entry) eventos.push(WalletBalanceChanged.from(wallet!, resultado.entry, ctx));
    } else if (resultado.type === 'rejected') {
      eventos.push(WagerTransactionRejected.from(tx, ctx, agora));
    } else {
      eventos.push(WagerTransactionPendingReference.from(tx, ctx, agora));
    }
    await r.outbox.add(eventos.map(e => OutboxMessage.enqueue(e)));
  }

  /**
   * Depois do commit (a referência já está visível para o worker): antecipa as transações que esperavam por esta.
   * Fora da transação para não segurar a trava da wallet; se falhar, o backoff normal das pendentes resolve.
   */
  private async acordarPendentes(tx: WagerTransaction): Promise<void> {
    if (!tx.isTerminal()) return;
    try {
      await this.uow.read(r => r.transactions.wakePendingReferencing(tx.providerId, tx.externalTransactionId, new Date()));
    } catch (e) {
      log.warn('não foi possível antecipar as pendentes', { transactionId: tx.id, error: String((e as Error)?.message ?? e) });
    }
  }

  /** Erro inesperado e permanente ao reprocessar: FAILED, para não tentar para sempre e ficar auditável. */
  private async marcarFalha(id: string, erro: unknown): Promise<void> {
    log.error('falha permanente ao reprocessar referência pendente', {
      transactionId: id,
      error: String((erro as Error)?.message ?? erro),
    });
    await this.uow.run(async r => {
      const guardada = await r.transactions.lockDuePending(id, new Date('9999-12-31T00:00:00Z'));
      if (!guardada) return;
      guardada.transaction.fail(FailureCode.InternalError, new Date());
      await r.transactions.save(guardada.transaction);
    });
    metrics.transactions.inc({ status: WagerTransactionStatus.Failed, kind: 'unknown' });
  }

  // métricas e log só depois do commit: o que foi contado foi confirmado
  private registrar(resultado: WagerResult, correlationId: string, messageId?: string): void {
    if (resultado.type === 'duplicate-message') {
      metrics.duplicates.inc({ source: 'inbox' });
      log.info('mensagem já processada; só confirmar', { correlationId, messageId });
      return;
    }
    const tx = resultado.transaction;
    if (resultado.idempotentReplay) metrics.duplicates.inc({ source: 'idempotency-key' });
    else metrics.transactions.inc({ status: tx.status, kind: tx.kind });
    log.info(resultado.idempotentReplay ? 'replay idempotente' : 'transação registrada', {
      correlationId,
      messageId,
      transactionId: tx.id,
      walletId: tx.walletId,
      providerId: tx.providerId,
      status: tx.status,
      failureCode: tx.failureCode,
    });
  }
}
