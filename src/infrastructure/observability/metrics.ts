import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export const registry = new Registry();

/** Métricas expostas em GET /metrics, no formato do Prometheus. */
export const metrics = {
  transactions: new Counter({
    name: 'wagering_transactions_total',
    help: 'Transações finalizadas ou adiadas, por status e kind',
    labelNames: ['status', 'kind'] as const,
    registers: [registry],
  }),
  duplicates: new Counter({
    name: 'wagering_duplicates_total',
    help: 'Duplicatas detectadas: replay pela chave de idempotência ou mensagem já vista na inbox',
    labelNames: ['source'] as const,
    registers: [registry],
  }),
  retries: new Counter({
    name: 'wagering_retries_total',
    help: 'Novas tentativas, por origem',
    labelNames: ['source'] as const,
    registers: [registry],
  }),
  dlq: new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Mensagens enviadas pela aplicação para a DLQ, por motivo',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  lockConflicts: new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Conflitos de trava no banco (deadlock, serialização, lock timeout)',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  outboxLag: new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Idade do evento mais antigo ainda não publicado',
    registers: [registry],
  }),
  outboxPublished: new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Eventos publicados pela outbox',
    registers: [registry],
  }),
  processing: new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Latência do processamento de uma transação, por origem',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),
  reconciliationDivergences: new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Reconciliações em que o saldo guardado diverge do extrato',
    registers: [registry],
  }),
};
