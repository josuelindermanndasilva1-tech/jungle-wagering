import {
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import { createApp } from '../../src/app.module';
import { config } from '../../src/config';
import ormConfig from '../../src/infrastructure/database/mikro-orm.config';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs';

const url = (db: string) => `postgres://${config.db.user}:${config.db.password}@${config.db.host}:${config.db.port}/${db}`;

/** Conexão direta ao banco de teste, para conferir o que ficou gravado sem passar pela aplicação. */
export const db = new SQL({ url: url(config.db.name), max: 5 });

let preparado: Promise<void> | undefined;

/** Uma vez por execução: banco de teste zerado e migrado, filas de teste apagadas (a aplicação recria). */
export function prepareInfra(): Promise<void> {
  preparado ??= (async () => {
    const admin = new SQL({ url: url('wagering'), max: 1 });
    await admin.unsafe(`drop database if exists ${config.db.name} with (force)`);
    await admin.unsafe(`create database ${config.db.name}`);
    await admin.close();
    const orm = await MikroORM.init(ormConfig);
    await orm.migrator.up();
    await orm.close(true);

    const sqs = new SqsGateway();
    for (const nome of [config.sqs.wagerQueue, config.sqs.deadLetterQueue, config.sqs.eventsQueue]) {
      try {
        const { QueueUrl } = await sqs.client.send(new GetQueueUrlCommand({ QueueName: nome }));
        await sqs.client.send(new DeleteQueueCommand({ QueueUrl }));
      } catch {
        // ainda não existia
      }
    }
  })();
  return preparado;
}

export interface TestApp {
  app: INestApplication;
  url: string;
  close(): Promise<void>;
}

/** A aplicação inteira no processo do teste, numa porta livre, sem workers (o teste chama cada um). */
export async function startApp(): Promise<TestApp> {
  await prepareInfra();
  const app = await createApp();
  await app.listen(0);
  const endereco = app.getHttpServer().address() as { port: number };
  return { app, url: `http://127.0.0.1:${endereco.port}`, close: () => app.close() };
}

export interface Instance {
  url: string;
  proc: ReturnType<typeof Bun.spawn>;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

/** Outra instância de verdade: um processo `bun src/main.ts` separado, com o mesmo banco e as mesmas filas. */
export async function spawnInstance(nome: string, env: Record<string, string> = {}): Promise<Instance> {
  await prepareInfra();
  const port = 32000 + Math.floor(Math.random() * 20000);
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, PORT: String(port), INSTANCE_ID: nome, WORKERS: 'consumer,outbox,pending', ...env },
    stdout: process.env.DEBUG_INSTANCIA ? Bun.file(`/tmp/inst-${nome}.log`) : 'ignore',
    stderr: process.env.DEBUG_INSTANCIA ? Bun.file(`/tmp/inst-${nome}.err`) : 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health/ready`)).ok) break;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(100);
  }
  return {
    url: base,
    proc,
    async stop(signal = 'SIGTERM') {
      proc.kill(signal);
      await proc.exited;
    },
  };
}

export const money = (amount: string, currency = 'BRL') => ({ amount, currency });

export async function createWallet(base: string, amount: string, currency = 'BRL'): Promise<{ id: string; playerId: string }> {
  const playerId = crypto.randomUUID();
  const r = await fetch(`${base}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: money(amount, currency) }),
  });
  if (r.status !== 201) throw new Error(`createWallet: ${r.status} ${await r.text()}`);
  return (await r.json()) as { id: string; playerId: string };
}

export interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wager(w: { id: string; playerId: string }, kind: string, amount: string, extra: Partial<WagerBody> = {}): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${crypto.randomUUID()}`,
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: money(amount),
    ...extra,
  };
}

export async function submit(base: string, body: WagerBody, key = `${body.providerId}:${body.externalTransactionId}`) {
  const r = await fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

/** Como um provedor de verdade: 503 (falha transitória, ex.: fila longa na trava de uma wallet quente) é reenviado. */
export async function submitWithRetry(base: string, body: WagerBody, tentativas = 20) {
  for (let i = 1; ; i++) {
    try {
      const r = await submit(base, body);
      if (r.status !== 503 || i >= tentativas) return r;
    } catch (e) {
      if (i >= tentativas) throw e;
    }
    await Bun.sleep(50 * i);
  }
}

/** wallet.balance == saldo reconstruído pelo extrato, e o extrato encadeado do primeiro ao último lançamento. */
export async function walletState(walletId: string) {
  const [w] = await db`select balance::text, version from wallets where id = ${walletId}`;
  const lancamentos = await db`
    select direction, amount::text, balance_before::text, balance_after::text
      from wallet_ledger_entries where wallet_id = ${walletId} order by seq`;
  let saldo = 0n;
  let encadeado = true;
  for (const l of lancamentos) {
    if (centavos(l.balance_before) !== saldo) encadeado = false;
    saldo += (l.direction === 'CREDIT' ? 1n : -1n) * centavos(l.amount);
    if (centavos(l.balance_after) !== saldo) encadeado = false;
  }
  return {
    balance: w.balance as string,
    version: Number(w.version),
    entries: lancamentos.length,
    ledgerBalance: reais(saldo),
    chained: encadeado,
  };
}

const centavos = (v: string): bigint => {
  const [i, d = ''] = v.replace('-', '').split('.');
  return (v.startsWith('-') ? -1n : 1n) * (BigInt(i!) * 100n + BigInt(d.padEnd(2, '0')));
};
const reais = (c: bigint): string =>
  `${c < 0n ? '-' : ''}${(c < 0n ? -c : c) / 100n}.${((c < 0n ? -c : c) % 100n).toString().padStart(2, '0')}`;

/** Lê (e apaga) tudo o que estiver numa fila até `ate` dizer que basta ou o tempo acabar. */
export async function drainQueue(nome: string, ate: (corpos: string[]) => boolean, tempoMs = 20_000) {
  const sqs = new SqsGateway();
  const { QueueUrl } = await sqs.client.send(new GetQueueUrlCommand({ QueueName: nome }));
  const mensagens: { body: string; attributes: Record<string, string> }[] = [];
  const limite = Date.now() + tempoMs;
  while (Date.now() < limite && !ate(mensagens.map(m => m.body))) {
    const r = await sqs.client.send(
      new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }),
    );
    for (const m of r.Messages ?? []) {
      mensagens.push({
        body: m.Body ?? '',
        attributes: Object.fromEntries(Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? ''])),
      });
      await sqs.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle }));
    }
  }
  return mensagens;
}

export async function sendWagerMessage(body: WagerBody, messageId: string = crypto.randomUUID(), extra: Record<string, unknown> = {}) {
  const sqs = new SqsGateway();
  const { wager } = await sqs.queues();
  const envelope = {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` },
    ...extra,
  };
  await sqs.client.send(
    new SendMessageCommand({
      QueueUrl: wager,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: body.walletId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
  return envelope;
}
