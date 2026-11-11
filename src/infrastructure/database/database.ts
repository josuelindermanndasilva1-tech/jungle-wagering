import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import type { QueryResult } from '@mikro-orm/core';
import { type Repositories, UnitOfWork } from '../../application/ports';
import { config } from '../../config';
import { metrics } from '../observability/metrics';
import ormConfig from './mikro-orm.config';
import { sqlRepositories } from './sql-repositories';

/** SQL com parâmetros `?`, sempre preso a uma conexão (de uma transação, ou do pool em modo autocommit). */
export interface Sql {
  all<T = Record<string, any>>(query: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, any>>(query: string, params?: unknown[]): Promise<T | undefined>;
  run(query: string, params?: unknown[]): Promise<number>;
}

const bind = (em: EntityManager): Sql => ({
  all: (q, p = []) => em.execute(q, p as any[], 'all'),
  one: async (q, p = []) => ((await em.execute(q, p as any[], 'all')) as any[])[0],
  run: async (q, p = []) => (await em.execute<QueryResult>(q, p as any[], 'run')).affectedRows,
});

export const sqlState = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

const CONFLITO = new Map([
  ['40P01', 'deadlock'],
  ['40001', 'serialization'],
  ['55P03', 'lock-timeout'],
]);

/** Falha de infraestrutura que pode passar sozinha: o chamador deve tentar de novo mais tarde (503 / retry na fila). */
export function isTransientError(e: unknown): boolean {
  const code = sqlState(e) ?? '';
  if (CONFLITO.has(code) || code.startsWith('08') || ['57P01', '57P02', '57P03', '53300'].includes(code)) return true;
  const msg = String((e as Error)?.message ?? '');
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|Connection terminated|connection.*closed|terminating connection|timeout exceeded when trying to connect/i.test(
    msg,
  );
}

export const isUniqueViolation = (e: unknown): boolean => sqlState(e) === '23505';

/**
 * Transações curtas no READ COMMITTED do Postgres, com `lock_timeout` para ninguém esperar uma trava para sempre.
 * Deadlock e falha de serialização desfazem a transação inteira, então repetir é seguro: até 3 tentativas.
 */
export class Database extends UnitOfWork {
  private constructor(private readonly orm: MikroORM) {
    super();
  }

  static async connect(): Promise<Database> {
    return new Database(await MikroORM.init(ormConfig));
  }

  async transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    for (let tentativa = 1; ; tentativa++) {
      try {
        return await this.orm.em.fork().transactional(async em => {
          const sql = bind(em);
          await sql.run(`set local lock_timeout = ${Math.trunc(config.db.lockTimeoutMs)}`);
          return fn(sql);
        });
      } catch (e) {
        const motivo = CONFLITO.get(sqlState(e) ?? '');
        if (!motivo) throw e;
        metrics.lockConflicts.inc({ reason: motivo });
        if (motivo === 'lock-timeout' || tentativa >= 3) throw e;
        metrics.retries.inc({ source: 'db-transaction' });
        await Bun.sleep(5 + Math.random() * 20 * tentativa);
      }
    }
  }

  /** Fora de transação: cada comando é atômico sozinho (leituras e consultas de uma linha). */
  sql(): Sql {
    return bind(this.orm.em.fork());
  }

  override run<T>(fn: (r: Repositories) => Promise<T>): Promise<T> {
    return this.transaction(sql => fn(sqlRepositories(sql)));
  }

  override read<T>(fn: (r: Repositories) => Promise<T>): Promise<T> {
    return fn(sqlRepositories(this.sql()));
  }

  override isTransient(error: unknown): boolean {
    return isTransientError(error);
  }

  async ping(): Promise<boolean> {
    try {
      await this.sql().one('select 1 as ok');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.orm.close(true);
  }
}
