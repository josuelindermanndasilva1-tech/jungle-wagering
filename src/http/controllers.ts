import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { NotFoundError, InvalidRequestError } from '../application/errors';
import { isUuid, parseCreateWallet, parseWagerCommand } from '../application/input';
import { UnitOfWork } from '../application/ports';
import { ProcessWager } from '../application/process-wager';
import { CreateWallet, Queries, ReconcileWallet } from '../application/wallets';
import { Database } from '../infrastructure/database/database';
import { SqsGateway } from '../infrastructure/messaging/sqs';
import { registry, metrics } from '../infrastructure/observability/metrics';
import { CorrelationId, ProviderAuthGuard } from './support';
import { httpStatusFor, ledgerEntryView, transactionView, wagerResultView, walletView } from './views';

// id que não é UUID não existe: 404, sem chegar ao banco
const id = (valor: string, nome: string): string => {
  if (!isUuid(valor)) throw new NotFoundError(`${nome} não encontrada`);
  return valor.toLowerCase();
};

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly reconcile: ReconcileWallet,
    private readonly queries: Queries,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @CorrelationId() correlationId: string) {
    return walletView(await this.createWallet.execute(parseCreateWallet(body), { correlationId }));
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return walletView(await this.queries.wallet(id(walletId, 'wallet')));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const n = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new InvalidRequestError('limit deve ser um inteiro entre 1 e 200');
    const pagina = await this.queries.ledger(id(walletId, 'wallet'), cursor || undefined, n);
    return { entries: pagina.entries.map(ledgerEntryView), nextCursor: pagina.nextCursor ?? null };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconciliation(@Param('walletId') walletId: string, @CorrelationId() correlationId: string) {
    return this.reconcile.execute(id(walletId, 'wallet'), correlationId);
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly processWager: ProcessWager,
    private readonly queries: Queries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const resultado = await this.processWager.execute(parseWagerCommand(body, idempotencyKey), { source: 'http', correlationId });
    if (resultado.type !== 'settled') throw new Error('resultado inesperado para a entrada HTTP');
    res.status(httpStatusFor(resultado.transaction));
    return wagerResultView(resultado.transaction, resultado.idempotentReplay);
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') transactionId: string) {
    return transactionView(await this.queries.transaction(id(transactionId, 'transação')));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return transactionView(await this.queries.transactionByExternalId(providerId, externalTransactionId));
  }
}

/** Sem autenticação: liveness, readiness e métricas. */
@Controller()
export class OpsController {
  constructor(
    private readonly db: Database,
    private readonly sqs: SqsGateway,
    private readonly uow: UnitOfWork,
  ) {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([this.db.ping(), this.sqs.ping()]);
    res.status(postgres && sqs ? 200 : 503);
    return { status: postgres && sqs ? 'ok' : 'unavailable', checks: { postgres: postgres ? 'up' : 'down', sqs: sqs ? 'up' : 'down' } };
  }

  @Get('metrics')
  async metrics(@Res() res: Response) {
    try {
      metrics.outboxLag.set(await this.uow.read(r => r.outbox.oldestPendingAgeSeconds(new Date())));
    } catch {
      // sem banco, as outras métricas continuam disponíveis
    }
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }
}
