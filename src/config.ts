// Configuração vinda do ambiente. Os padrões batem com o docker-compose.yml, então `bun run start` funciona sem .env.
const num = (valor: string | undefined, padrao: number): number => (valor ? Number(valor) : padrao);

export const config = {
  port: num(process.env.PORT, 3000),
  instanceId: process.env.INSTANCE_ID ?? `pid-${process.pid}`,
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: num(process.env.DB_PORT, 5434),
    user: process.env.DB_USER ?? 'wagering',
    password: process.env.DB_PASSWORD ?? 'wagering',
    name: process.env.DB_NAME ?? 'wagering',
    poolMax: num(process.env.DB_POOL_MAX, 20),
    /** Quanto uma transação espera pela trava de uma wallet antes de desistir (falha transitória, 503). */
    lockTimeoutMs: num(process.env.DB_LOCK_TIMEOUT_MS, 5000),
  },
  sqs: {
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: process.env.AWS_REGION ?? 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    wagerQueue: process.env.SQS_WAGER_QUEUE ?? 'wager-transactions.fifo',
    deadLetterQueue: process.env.SQS_DLQ ?? 'wager-transactions-dlq.fifo',
    eventsQueue: process.env.SQS_EVENTS_QUEUE ?? 'wagering-events.fifo',
    /** Recebimentos sem sucesso antes de a própria SQS mover a mensagem para a DLQ (redrive policy). */
    maxReceiveCount: num(process.env.SQS_MAX_RECEIVE_COUNT, 5),
    visibilityTimeoutS: num(process.env.SQS_VISIBILITY_TIMEOUT_S, 30),
    waitTimeS: num(process.env.SQS_WAIT_TIME_S, 2),
    /** Espera antes de a mensagem com falha transitória voltar à fila: base × 2^(recebimentos - 1), no máximo 5 min. */
    retryBaseDelayS: num(process.env.SQS_RETRY_BASE_DELAY_S, 2),
    /** Em desenvolvimento a aplicação cria as filas que faltarem; em produção isso é da infraestrutura. */
    createQueues: (process.env.SQS_CREATE_QUEUES ?? 'true') === 'true',
  },
  /** Workers que esta instância roda, além da API: consumer (fila), outbox (publicação), pending (referências). */
  workers: new Set(
    (process.env.WORKERS ?? 'consumer,outbox,pending')
      .split(',')
      .map(w => w.trim())
      .filter(Boolean),
  ),
  pending: {
    maxAttempts: num(process.env.PENDING_MAX_ATTEMPTS, 8),
    baseDelayMs: num(process.env.PENDING_BASE_DELAY_MS, 1000),
    pollMs: num(process.env.PENDING_POLL_MS, 1000),
  },
  outbox: {
    pollMs: num(process.env.OUTBOX_POLL_MS, 500),
    batchSize: 10,
  },
  shutdownGraceMs: num(process.env.SHUTDOWN_GRACE_MS, 10_000),
};
