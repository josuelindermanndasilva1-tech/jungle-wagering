import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { UnitOfWork } from '../../application/ports';
import { ProcessWager } from '../../application/process-wager';
import { config } from '../../config';
import { log } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { SqsGateway } from './sqs';

/** Laço simples: repete o trabalho e dorme quando não há nada a fazer. Para no shutdown. */
abstract class Laco implements OnApplicationBootstrap, OnModuleDestroy {
  private parando = false;
  private laco?: Promise<void>;
  protected abstract readonly nome: string;
  protected abstract readonly intervaloMs: number;

  protected abstract ativo(): boolean;
  /** Devolve quanto trabalho fez; zero faz o laço esperar o intervalo. */
  protected abstract rodada(): Promise<number>;

  onApplicationBootstrap(): void {
    if (this.ativo()) this.laco = this.rodar();
  }

  async onModuleDestroy(): Promise<void> {
    this.parando = true;
    await this.laco;
  }

  private async rodar(): Promise<void> {
    while (!this.parando) {
      try {
        if ((await this.rodada()) === 0) await Bun.sleep(this.intervaloMs);
      } catch (e) {
        log.warn(`${this.nome}: falha; nova tentativa em 1 s`, { error: String((e as Error)?.message ?? e) });
        await Bun.sleep(1000);
      }
    }
  }
}

/**
 * Publica a outbox. Cada rodada trava até `batchSize` eventos vencidos com FOR UPDATE SKIP LOCKED, publica e marca
 * na mesma transação. Vários publishers convivem: cada um pega linhas diferentes. Se o processo morrer depois de
 * publicar e antes do commit, o evento sai de novo; o consumidor deduplica pelo eventId.
 */
@Injectable()
export class OutboxPublisher extends Laco {
  protected readonly nome = 'outbox';
  protected readonly intervaloMs = config.outbox.pollMs;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly sqs: SqsGateway,
  ) {
    super();
  }

  protected ativo(): boolean {
    return config.workers.has('outbox');
  }

  protected async rodada(): Promise<number> {
    const n = await this.publishBatch();
    metrics.outboxLag.set(await this.uow.read(r => r.outbox.oldestPendingAgeSeconds(new Date())));
    return n;
  }

  async publishBatch(): Promise<number> {
    const publicados = await this.uow.run(async r => {
      const agora = new Date();
      const lote = await r.outbox.lockDue(agora, config.outbox.batchSize);
      if (!lote.length) return 0;
      let aceitos = new Set<string>();
      try {
        aceitos = await this.sqs.publishEvents(lote);
      } catch (e) {
        log.warn('falha ao publicar eventos; nova tentativa com backoff', { error: String((e as Error)?.message ?? e) });
      }
      for (const m of lote) {
        if (aceitos.has(m.id)) m.markPublished(agora);
        else {
          m.scheduleRetry(agora);
          metrics.retries.inc({ source: 'outbox' });
        }
      }
      await r.outbox.save(lote);
      return aceitos.size;
    });
    metrics.outboxPublished.inc(publicados);
    return publicados;
  }
}

/** Reprocessa as transações em PENDING_REFERENCE quando a próxima tentativa vence (backoff exponencial). */
@Injectable()
export class PendingReferenceWorker extends Laco {
  protected readonly nome = 'pending-reference';
  protected readonly intervaloMs = config.pending.pollMs;

  constructor(private readonly processWager: ProcessWager) {
    super();
  }

  protected ativo(): boolean {
    return config.workers.has('pending');
  }

  protected rodada(): Promise<number> {
    return this.processWager.retryDuePending();
  }
}
