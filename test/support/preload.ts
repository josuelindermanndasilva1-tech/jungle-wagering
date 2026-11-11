import { setDefaultTimeout } from 'bun:test';

// Os testes usam um banco e filas próprios, para não misturar com o ambiente de desenvolvimento.
// Roda antes de qualquer import da aplicação: o config.ts lê o ambiente uma vez só.
setDefaultTimeout(120_000);
const padrao: Record<string, string> = {
  DB_NAME: 'wagering_test',
  SQS_WAGER_QUEUE: 'test-wager-transactions.fifo',
  SQS_DLQ: 'test-wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE: 'test-wagering-events.fifo',
  SQS_MAX_RECEIVE_COUNT: '2',
  SQS_RETRY_BASE_DELAY_S: '0',
  SQS_VISIBILITY_TIMEOUT_S: '5',
  SQS_WAIT_TIME_S: '1',
  PENDING_BASE_DELAY_MS: '100',
  PENDING_MAX_ATTEMPTS: '3',
  PENDING_POLL_MS: '100',
  OUTBOX_POLL_MS: '100',
  LOG_LEVEL: 'silent',
  // a aplicação dentro do processo de teste não roda workers; cada teste chama o que precisa
  WORKERS: '',
};
for (const [k, v] of Object.entries(padrao)) process.env[k] ??= v;
