import { Injectable } from '@nestjs/common';
import { type EventContext, WalletBalanceChanged } from '../domain/events';
import { newId } from '../domain/ids';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger-entry';
import { OutboxMessage } from '../domain/messaging';
import { Money, type MoneyProps } from '../domain/money';
import { payloadHash } from '../domain/payload-hash';
import { Wallet } from '../domain/wallet';
import { WagerTransaction } from '../domain/wager-transaction';
import { log } from '../infrastructure/observability/logger';
import { metrics } from '../infrastructure/observability/metrics';
import { ConflictError, NotFoundError } from './errors';
import { type LedgerPage, UnitOfWork } from './ports';

/**
 * Abre a wallet. Com saldo inicial maior que zero, a transação interna OPENING e o crédito no extrato
 * entram na mesma transação SQL da wallet.
 */
@Injectable()
export class CreateWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(cmd: { playerId: string; initialBalance: Money }, ctx: EventContext): Promise<Wallet> {
    const agora = new Date();
    const wallet = Wallet.open({ id: newId(), playerId: cmd.playerId, initialBalance: cmd.initialBalance, now: agora });
    await this.uow.run(async r => {
      if (!(await r.wallets.insert(wallet))) {
        throw new ConflictError('WALLET_ALREADY_EXISTS', `o player já tem wallet em ${wallet.currency}`);
      }
      if (!cmd.initialBalance.isPositive()) return;
      const abertura = WagerTransaction.opening({
        id: newId(),
        providerId: 'internal',
        externalTransactionId: `opening:${wallet.id}`,
        idempotencyKey: `opening:${wallet.id}`,
        payloadHash: payloadHash({ walletId: wallet.id, initialBalance: cmd.initialBalance.toJSON() }),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'opening',
        gameId: 'internal',
        money: cmd.initialBalance,
        createdAt: agora,
      });
      abertura.markProcessed(undefined, agora, wallet.balance);
      await r.transactions.insertIfAbsent(abertura, ctx.correlationId);
      const entrada = WalletLedgerEntry.create({
        walletId: wallet.id,
        transactionId: abertura.id,
        direction: LedgerDirection.Credit,
        money: cmd.initialBalance,
        balanceBefore: Money.zero(wallet.currency),
        balanceAfter: wallet.balance,
        createdAt: agora,
      });
      await r.ledger.insert(entrada);
      await r.outbox.add([OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entrada, ctx))]);
    });
    log.info('wallet criada', { correlationId: ctx.correlationId, walletId: wallet.id });
    return wallet;
  }
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Compara o saldo guardado com o saldo reconstruído pelo extrato. Divergência é sinalizada, nunca corrigida em silêncio. */
@Injectable()
export class ReconcileWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const t = await this.uow.read(r => r.wallets.reconciliationTotals(walletId));
    if (!t) throw new NotFoundError('wallet não encontrada');
    const diferenca = t.stored.subtract(t.calculated);
    const consistent = diferenca.isZero();
    if (!consistent) {
      metrics.reconciliationDivergences.inc();
      log.error('saldo da wallet diverge do extrato', { correlationId, walletId, difference: diferenca.toString() });
    }
    return {
      walletId,
      storedBalance: t.stored.toJSON(),
      calculatedBalance: t.calculated.toJSON(),
      difference: diferenca.toJSON(),
      consistent,
      checkedEntries: t.entries,
    };
  }
}

/** Consultas de leitura, fora de transação. */
@Injectable()
export class Queries {
  constructor(private readonly uow: UnitOfWork) {}

  async wallet(id: string): Promise<Wallet> {
    const w = await this.uow.read(r => r.wallets.find(id));
    if (!w) throw new NotFoundError('wallet não encontrada');
    return w;
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    await this.wallet(walletId);
    return this.uow.read(r => r.ledger.page(walletId, cursor, limit));
  }

  async transaction(id: string): Promise<WagerTransaction> {
    const t = await this.uow.read(r => r.transactions.findById(id));
    if (!t) throw new NotFoundError('transação não encontrada');
    return t;
  }

  async transactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const t = await this.uow.read(r => r.transactions.findByExternalId(providerId, externalTransactionId));
    if (!t) throw new NotFoundError('transação não encontrada');
    return t;
  }
}
