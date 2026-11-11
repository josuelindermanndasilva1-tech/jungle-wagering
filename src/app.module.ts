import { type INestApplication, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { UnitOfWork } from './application/ports';
import { ProcessWager } from './application/process-wager';
import { CreateWallet, Queries, ReconcileWallet } from './application/wallets';
import { OpsController, WageringController, WalletsController } from './http/controllers';
import { correlationMiddleware, ErrorFilter } from './http/support';
import { Database } from './infrastructure/database/database';
import { SqsGateway } from './infrastructure/messaging/sqs';
import { WagerConsumer } from './infrastructure/messaging/wager-consumer';
import { OutboxPublisher, PendingReferenceWorker } from './infrastructure/messaging/workers';
import { JsonNestLogger } from './infrastructure/observability/logger';

/** Fecha o pool do banco por último: no shutdown do Nest, onModuleDestroy (workers) vem antes de onApplicationShutdown. */
class Encerramento implements OnApplicationShutdown {
  constructor(private readonly db: Database) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}

@Module({
  controllers: [WalletsController, WageringController, OpsController],
  providers: [
    { provide: Database, useFactory: () => Database.connect() },
    { provide: UnitOfWork, useExisting: Database },
    { provide: SqsGateway, useValue: new SqsGateway() },
    { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: Encerramento, useFactory: (db: Database) => new Encerramento(db), inject: [Database] },
    ProcessWager,
    CreateWallet,
    ReconcileWallet,
    Queries,
    WagerConsumer,
    OutboxPublisher,
    PendingReferenceWorker,
  ],
})
export class AppModule {}

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: new JsonNestLogger() });
  app.use(correlationMiddleware);
  app.enableShutdownHooks();
  return app;
}
