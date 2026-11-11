import { createApp } from './app.module';
import { config } from './config';
import { log } from './infrastructure/observability/logger';

const app = await createApp();
await app.listen(config.port);
log.info('instância no ar', { port: config.port, workers: [...config.workers].join(',') });
