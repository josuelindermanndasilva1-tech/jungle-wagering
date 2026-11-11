import { describe, expect, test } from 'bun:test';
import { InvalidRequestError } from '../../src/application/errors';
import { parseWagerCommand } from '../../src/application/input';
import { wagerPayloadHash } from '../../src/application/process-wager';
import { WalletBalanceChanged } from '../../src/domain/events';
import { InboxMessage, OutboxMessage } from '../../src/domain/messaging';
import { Money } from '../../src/domain/money';
import { canonicalJson } from '../../src/domain/payload-hash';
import { Wallet } from '../../src/domain/wallet';

const corpo = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};
const hash = (body: Record<string, unknown>, chave = 'provider-a:transaction-123') => wagerPayloadHash(parseWagerCommand(body, chave));

describe('payloadHash', () => {
  test('JSON canônico: a ordem das chaves não importa', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
    const embaralhado = Object.fromEntries(Object.entries(corpo).reverse());
    expect(hash(embaralhado)).toBe(hash(corpo));
  });

  test('mesma chave com payload divergente: hashes diferentes (é conflito, não replay)', () => {
    expect(hash({ ...corpo, money: { amount: '26.00', currency: 'BRL' } })).not.toBe(hash(corpo));
    expect(hash({ ...corpo, roundId: 'outra' })).not.toBe(hash(corpo));
  });

  test('a Idempotency-Key e a representação do valor não entram: "25.5" e "25.50" são o mesmo pedido', () => {
    expect(hash(corpo, 'outra-chave')).toBe(hash(corpo));
    expect(hash({ ...corpo, money: { amount: '25', currency: 'BRL' } })).toBe(hash(corpo));
  });
});

describe('validação de entrada', () => {
  const erros = (body: unknown, chave: unknown = 'k') => {
    try {
      parseWagerCommand(body, chave);
      return [];
    } catch (e) {
      return (e as InvalidRequestError).details;
    }
  };

  test('OPENING não pode ser submetido', () => {
    expect(erros({ ...corpo, kind: 'OPENING' }).join()).toContain('kind');
  });

  test('Idempotency-Key obrigatória', () => {
    expect(erros(corpo, null).join()).toContain('Idempotency-Key');
    expect(erros(corpo, '').join()).toContain('Idempotency-Key');
  });

  test('REFUND e ROLLBACK exigem referência; dinheiro inválido é recusado', () => {
    expect(erros({ ...corpo, kind: 'REFUND' }).join()).toContain('referenceExternalTransactionId');
    expect(erros({ ...corpo, money: { amount: 25, currency: 'BRL' } }).join()).toContain('money');
    expect(erros({ ...corpo, money: { amount: '-1.00', currency: 'BRL' } }).join()).toContain('money');
  });

  test('UUIDs normalizados em minúsculas', () => {
    expect(parseWagerCommand({ ...corpo, playerId: corpo.playerId.toUpperCase() }, 'k').playerId).toBe(corpo.playerId);
  });
});

describe('inbox e outbox', () => {
  test('OutboxMessage: backoff de 1 s, 2 s, 4 s... e publicação', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }), now: new Date(0) });
    const entry = w.credit(Money.from({ amount: '1.00', currency: 'BRL' }), 't1', new Date(0));
    const msg = OutboxMessage.enqueue(WalletBalanceChanged.from(w, entry, { correlationId: 'c1' }));
    const agora = new Date(1_000_000);
    expect(msg.isDue(agora)).toBe(true);
    msg.scheduleRetry(agora);
    expect(msg.nextAttemptAt!.getTime() - agora.getTime()).toBe(1000);
    msg.scheduleRetry(agora);
    expect(msg.nextAttemptAt!.getTime() - agora.getTime()).toBe(2000);
    expect(msg.isDue(agora)).toBe(false);
    msg.markPublished(agora);
    expect(msg.isPending()).toBe(false);
  });

  test('evento: tipo e versão vêm da classe; dinheiro vai como MoneyProps', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }), now: new Date(0) });
    const entry = w.debit(Money.from({ amount: '2.50', currency: 'BRL' }), 't1', new Date(0));
    const json = WalletBalanceChanged.from(w, entry, { correlationId: 'c1', causationId: 'm1' }).toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe('w1');
    expect(json.data.balanceAfter).toEqual({ amount: '7.50', currency: 'BRL' });
    expect(json.data.walletVersion).toBe(2);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json as never);
  });

  test('InboxMessage marca o processamento', () => {
    const m = InboxMessage.receive({ messageId: 'm1', consumerName: 'c', payloadHash: 'h', receivedAt: new Date(0) });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(new Date(1));
    expect(m.isProcessed()).toBe(true);
  });
});
