import type { Message } from '@aws-sdk/client-sqs';
import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConflictError, InvalidRequestError } from '../../application/errors';
import { parseWagerCommand } from '../../application/input';
import { UnitOfWork } from '../../application/ports';
import { ProcessWager, type WagerCommand } from '../../application/process-wager';
import { config } from '../../config';
import { DomainError } from '../../domain/errors';
import { payloadHash } from '../../domain/payload-hash';
import { log } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { SqsGateway } from './sqs';

export const CONSUMER_NAME = 'wager-transactions';

interface PedidoDaFila {
  messageId: string;
  correlationId: string;
  bodyHash: string;
  command: WagerCommand;
}

/** Envelope { messageId, type, occurredAt, data }; o data passa pela mesma validação da API. */
export function parseWagerMessage(body: string): PedidoDaFila {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(body);
  } catch {
    throw new InvalidRequestError('mensagem não é JSON');
  }
  if (msg === null || typeof msg !== 'object') throw new InvalidRequestError('mensagem não é um objeto');
  if (msg.type !== 'WagerTransactionRequested') throw new InvalidRequestError(`type inesperado: ${String(msg.type)}`);
  if (typeof msg.messageId !== 'string' || !msg.messageId.trim()) throw new InvalidRequestError('messageId obrigatório');
  const data = msg.data as Record<string, unknown> | undefined;
  return {
    messageId: msg.messageId,
    correlationId: typeof msg.correlationId === 'string' && msg.correlationId ? msg.correlationId : msg.messageId,
    // só o conteúdo: o mesmo messageId reenviado com outro occurredAt continua sendo a mesma mensagem
    bodyHash: payloadHash({ type: msg.type, data: msg.data }),
    command: parseWagerCommand(data, data?.idempotencyKey),
  };
}

/**
 * Consumidor da fila de transações. Usa o mesmo caso de uso da API; a inbox deduplica por (consumerName, messageId)
 * na mesma transação do efeito financeiro, e o ack (DeleteMessage) só acontece depois do commit.
 */
@Injectable()
export class WagerConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private parando = false;
  private readonly abort = new AbortController();
  private laco?: Promise<void>;

  constructor(
    private readonly sqs: SqsGateway,
    private readonly processWager: ProcessWager,
    private readonly uow: UnitOfWork,
  ) {}

  onApplicationBootstrap(): void {
    if (config.workers.has('consumer')) this.laco = this.rodar();
  }

  /** SIGTERM: para de buscar, termina o que já começou e devolve à fila o que não começou. */
  async onModuleDestroy(): Promise<void> {
    this.parando = true;
    this.abort.abort();
    await this.laco;
  }

  private async rodar(): Promise<void> {
    while (!this.parando) {
      try {
        const mensagens = await this.sqs.receive(this.abort.signal);
        if (mensagens.length) await this.processBatch(mensagens);
      } catch (e) {
        if (this.parando) break;
        log.warn('falha ao ler a fila; nova tentativa em 1 s', { error: String((e as Error)?.message ?? e) });
        await Bun.sleep(1000);
      }
    }
  }

  /** Grupos FIFO (uma wallet cada) em paralelo; dentro do grupo, na ordem de chegada. */
  async processBatch(mensagens: Message[]): Promise<void> {
    const grupos = new Map<string, Message[]>();
    for (const m of mensagens) {
      const g = m.Attributes?.MessageGroupId ?? m.MessageId ?? '';
      grupos.set(g, [...(grupos.get(g) ?? []), m]);
    }
    await Promise.all(
      [...grupos.values()].map(async lista => {
        for (const m of lista) {
          if (this.parando) await this.devolver(m);
          else await this.handle(m);
        }
      }),
    );
  }

  async handle(m: Message): Promise<void> {
    const recebimentos = Number(m.Attributes?.ApproximateReceiveCount ?? '1');
    let pedido: PedidoDaFila;
    try {
      pedido = parseWagerMessage(m.Body ?? '');
    } catch (e) {
      return this.paraDeadLetter(m, 'INVALID_MESSAGE', e);
    }
    const campos = {
      messageId: pedido.messageId,
      correlationId: pedido.correlationId,
      walletId: pedido.command.walletId,
      providerId: pedido.command.providerId,
    };
    try {
      await this.processWager.execute(pedido.command, {
        source: 'sqs',
        correlationId: pedido.correlationId,
        causationId: pedido.messageId,
        inbox: { consumerName: CONSUMER_NAME, messageId: pedido.messageId, payloadHash: pedido.bodyHash },
      });
    } catch (e) {
      // negócio já vira REJECTED dentro do caso de uso; aqui chegam payload inválido, conflito e infraestrutura
      if (e instanceof ConflictError) return this.paraDeadLetter(m, e.code, e);
      if (e instanceof InvalidRequestError || e instanceof DomainError) return this.paraDeadLetter(m, 'INVALID_MESSAGE', e);
      if (this.uow.isTransient(e)) {
        metrics.retries.inc({ source: 'sqs-consumer' });
        const espera = Math.min(config.sqs.retryBaseDelayS * 2 ** (recebimentos - 1), 300);
        log.warn('falha transitória; a mensagem volta para a fila', {
          ...campos,
          attempt: recebimentos,
          retryInSeconds: espera,
          error: String((e as Error).message),
        });
        await this.tentar(() => this.sqs.changeVisibility(m, espera));
        return;
      }
      return this.paraDeadLetter(m, 'PROCESSING_ERROR', e);
    }
    // ack depois do commit; se o ack falhar, a mensagem volta e a inbox reconhece a duplicata
    await this.tentar(() => this.sqs.delete(m));
  }

  private async paraDeadLetter(m: Message, reason: string, erro: unknown): Promise<void> {
    const detalhe =
      erro instanceof InvalidRequestError ? [erro.message, ...erro.details].join('; ') : String((erro as Error)?.message ?? erro);
    log.error('mensagem enviada para a DLQ', { messageId: m.MessageId, reason, error: detalhe });
    metrics.dlq.inc({ reason });
    await this.tentar(() => this.sqs.moveToDeadLetter(m, reason, detalhe));
  }

  private async devolver(m: Message): Promise<void> {
    await this.tentar(() => this.sqs.changeVisibility(m, 0));
  }

  // falhar ao falar com a SQS não derruba o laço: sem ack, a mensagem reaparece depois do visibility timeout
  private async tentar(acao: () => Promise<void>): Promise<void> {
    try {
      await acao();
    } catch (e) {
      log.warn('falha ao falar com a SQS', { error: String((e as Error)?.message ?? e) });
    }
  }
}
