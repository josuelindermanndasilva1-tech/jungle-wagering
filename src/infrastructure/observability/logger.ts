import type { LoggerService } from '@nestjs/common';
import { config } from '../../config';

/**
 * Campos que um log pode carregar. Só identificadores e estados: nada de payload completo nem valores monetários.
 */
export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  status?: string;
  failureCode?: string;
  reason?: string;
  error?: string;
  [extra: string]: string | number | boolean | undefined;
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const silencioso = process.env.LOG_LEVEL === 'silent';

function escrever(level: Level, msg: string, fields?: LogFields): void {
  if (silencioso) return;
  const linha = JSON.stringify({ time: new Date().toISOString(), level, msg, instance: config.instanceId, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(linha + '\n');
}

export const log = {
  debug: (msg: string, fields?: LogFields) => escrever('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => escrever('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => escrever('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => escrever('error', msg, fields),
};

/** Adaptador para os logs do próprio Nest saírem no mesmo formato JSON. */
export class JsonNestLogger implements LoggerService {
  log(message: unknown, context?: string) {
    escrever('info', String(message), { context });
  }
  error(message: unknown, trace?: string, context?: string) {
    escrever('error', String(message), { context, error: trace });
  }
  warn(message: unknown, context?: string) {
    escrever('warn', String(message), { context });
  }
  debug(message: unknown, context?: string) {
    escrever('debug', String(message), { context });
  }
  verbose(message: unknown, context?: string) {
    escrever('debug', String(message), { context });
  }
}
