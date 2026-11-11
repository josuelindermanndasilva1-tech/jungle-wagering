import { Money } from '../domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction';
import { InvalidRequestError } from './errors';
import type { WagerCommand } from './process-wager';

// Validação dos contratos de entrada, a mesma para a API e para a fila.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// OPENING é interno: não aparece aqui, então nem a API nem a fila conseguem submetê-lo
const SUBMETIVEIS: string[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

const ehObjeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

class Leitor {
  readonly erros: string[] = [];
  constructor(private readonly dados: Record<string, unknown>) {}

  texto(campo: string, max = 128, opcional = false): string | undefined {
    const v = this.dados[campo];
    if (v === undefined || v === null) {
      if (!opcional) this.erros.push(`${campo}: obrigatório`);
      return undefined;
    }
    if (typeof v !== 'string' || !v.trim() || v.length > max) {
      this.erros.push(`${campo}: texto não vazio de até ${max} caracteres`);
      return undefined;
    }
    return v;
  }

  // UUID em minúsculas: o banco devolve assim, e a comparação de player/wallet não pode depender da caixa
  uuid(campo: string): string {
    const v = this.dados[campo];
    if (!isUuid(v)) {
      this.erros.push(`${campo}: UUID obrigatório`);
      return '';
    }
    return v.toLowerCase();
  }

  dinheiro(campo: string): Money | undefined {
    try {
      return Money.from(this.dados[campo] as never);
    } catch (e) {
      this.erros.push(`${campo}: ${(e as Error).message}`);
      return undefined;
    }
  }
}

export function parseWagerCommand(data: unknown, idempotencyKey: unknown): WagerCommand {
  if (!ehObjeto(data)) throw new InvalidRequestError('o corpo deve ser um objeto JSON');
  const l = new Leitor(data);
  const chave = typeof idempotencyKey === 'string' && idempotencyKey.trim() && idempotencyKey.length <= 255 ? idempotencyKey : undefined;
  if (!chave) l.erros.push('Idempotency-Key: obrigatória (até 255 caracteres)');
  const kind = data.kind;
  if (typeof kind !== 'string' || !SUBMETIVEIS.includes(kind)) l.erros.push(`kind: um de ${SUBMETIVEIS.join(', ')}`);
  const comando = {
    providerId: l.texto('providerId'),
    externalTransactionId: l.texto('externalTransactionId'),
    playerId: l.uuid('playerId'),
    walletId: l.uuid('walletId'),
    roundId: l.texto('roundId'),
    gameId: l.texto('gameId'),
    money: l.dinheiro('money'),
    referenceExternalTransactionId: l.texto('referenceExternalTransactionId', 128, true),
  };
  const exigeReferencia = kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  if (exigeReferencia && !comando.referenceExternalTransactionId) l.erros.push(`referenceExternalTransactionId: obrigatório para ${kind}`);
  if (kind === WagerTransactionKind.Bet && comando.referenceExternalTransactionId)
    l.erros.push('referenceExternalTransactionId: BET não referencia outra transação');
  if (comando.money && kind !== WagerTransactionKind.Loss && comando.money.isZero()) l.erros.push('money: o valor deve ser maior que zero');
  if (l.erros.length) throw new InvalidRequestError('payload inválido', l.erros);
  return { ...comando, kind: kind as WagerTransactionKind, idempotencyKey: chave! } as WagerCommand;
}

export function parseCreateWallet(body: unknown): { playerId: string; initialBalance: Money } {
  if (!ehObjeto(body)) throw new InvalidRequestError('o corpo deve ser um objeto JSON');
  const l = new Leitor(body);
  const playerId = l.uuid('playerId');
  const initialBalance = l.dinheiro('initialBalance');
  if (l.erros.length) throw new InvalidRequestError('payload inválido', l.erros);
  return { playerId, initialBalance: initialBalance! };
}
