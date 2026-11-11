import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { InboxMessage, OutboxMessage } from '../domain/messaging';
import type { Money } from '../domain/money';
import type { Wallet } from '../domain/wallet';
import type { WagerTransaction } from '../domain/wager-transaction';

// Portas: o que os casos de uso precisam da persistência. O adaptador SQL fica em infrastructure/database.

export interface ReconciliationTotals {
  stored: Money;
  calculated: Money;
  entries: number;
}

export interface WalletRepository {
  /** false se já existe wallet para o mesmo player e moeda (ON CONFLICT DO NOTHING). */
  insert(wallet: Wallet): Promise<boolean>;
  find(id: string): Promise<Wallet | undefined>;
  /** Trava a linha da wallet até o fim da transação (SELECT ... FOR UPDATE): a wallet é a unidade de concorrência. */
  findForUpdate(id: string): Promise<Wallet | undefined>;
  /** Grava saldo e version; falha se a version no banco não for a esperada (proteção extra contra lost update). */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
  /** Saldo guardado e saldo recalculado pelo extrato, lidos no mesmo snapshot. */
  reconciliationTotals(walletId: string): Promise<ReconciliationTotals | undefined>;
}

export interface StoredTransaction {
  transaction: WagerTransaction;
  correlationId: string;
}

export interface WagerTransactionRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. false: a chave de idempotência, ou o par (provider, id externo), já existe. */
  insertIfAbsent(tx: WagerTransaction, correlationId: string): Promise<boolean>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  save(tx: WagerTransaction): Promise<void>;
  findDuePendingIds(now: Date, limit: number): Promise<string[]>;
  /** Trava uma PENDING_REFERENCE vencida; SKIP LOCKED faz outra instância pular a que já está sendo tratada. */
  lockDuePending(id: string, now: Date): Promise<StoredTransaction | undefined>;
  /** Antecipa a próxima tentativa das transações que esperavam por esta. */
  wakePendingReferencing(providerId: string, externalTransactionId: string, now: Date): Promise<void>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage>;
}

export interface OutboxRepository {
  add(messages: OutboxMessage[]): Promise<void>;
  /** Mensagens vencidas, travadas com SKIP LOCKED: dois publishers nunca pegam a mesma ao mesmo tempo. */
  lockDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(messages: OutboxMessage[]): Promise<void>;
  oldestPendingAgeSeconds(now: Date): Promise<number>;
}

export interface InboxRepository {
  /** Registra a mensagem. Se o par (consumer, messageId) já existia, devolve o registro antigo. */
  receive(message: InboxMessage): Promise<InboxMessage | undefined>;
  save(message: InboxMessage): Promise<void>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

export abstract class UnitOfWork {
  /** Tudo o que roda em `fn` entra numa transação SQL só: ou tudo é confirmado junto, ou nada. */
  abstract run<T>(fn: (r: Repositories) => Promise<T>): Promise<T>;
  /** Leituras fora de transação. */
  abstract read<T>(fn: (r: Repositories) => Promise<T>): Promise<T>;
  /** Falha de infraestrutura que pode passar sozinha (conexão, trava, deadlock): vale tentar de novo depois. */
  abstract isTransient(error: unknown): boolean;
}
