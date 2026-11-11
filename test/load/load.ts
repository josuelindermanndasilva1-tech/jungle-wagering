/**
 * Teste de carga: `bun run test:load` (com `docker compose up -d` rodando).
 * Sobe 3 instâncias da aplicação, cria wallets e dispara apostas em paralelo contra as três,
 * metade em wallets "frias" (muitas wallets) e metade numa wallet "quente" (todas na mesma).
 * Mede vazão, latência (p50/p95/p99), erros, conflitos de trava (das métricas) e o atraso da outbox.
 */
export {};

process.env.LOG_LEVEL ??= 'silent';
await import('../support/preload');
const { createWallet, spawnInstance, submit, wager, walletState, db } = await import('../support/infra');

const DURACAO_S = Number(process.env.LOAD_SECONDS ?? 20);
const CONCORRENCIA = Number(process.env.LOAD_CONCURRENCY ?? 30);
const WALLETS_FRIAS = 50;
/** Fração das apostas que vai para a wallet quente (todas disputando a mesma trava). */
const QUENTE = Number(process.env.LOAD_HOT_RATIO ?? 0.5);

// LOAD_URLS: usar instâncias já rodando (ex.: as 3 réplicas do docker compose); sem ele, sobe 3 processos locais
const workers = process.env.LOAD_WORKERS ?? 'consumer,outbox,pending';
const instancias = process.env.LOAD_URLS
  ? []
  : await Promise.all(
      ['carga-1', 'carga-2', 'carga-3'].map(n => spawnInstance(n, { WORKERS: workers, OUTBOX_POLL_MS: '500', PENDING_POLL_MS: '1000' })),
    );
const urls = process.env.LOAD_URLS ? process.env.LOAD_URLS.split(',') : instancias.map(i => i.url);
const onde = process.env.LOAD_URLS
  ? '3 réplicas no Docker (mesma rede do PostgreSQL)'
  : '3 processos no host (cada consulta atravessa a rede do Docker Desktop)';
const frias = await Promise.all(Array.from({ length: WALLETS_FRIAS }, (_, i) => createWallet(urls[i % 3]!, '1000000.00')));
const quente = await createWallet(urls[0]!, '1000000.00');

const latencias: number[] = [];
const status = new Map<number, number>();
let enviadas = 0;
const fim = Date.now() + DURACAO_S * 1000;

async function trabalhador(n: number) {
  while (Date.now() < fim) {
    const w = Math.random() < QUENTE ? quente : frias[(n + enviadas) % WALLETS_FRIAS]!;
    const url = urls[enviadas++ % 3]!;
    const t0 = performance.now();
    try {
      const r = await submit(url, wager(w, 'BET', '0.01'));
      status.set(r.status, (status.get(r.status) ?? 0) + 1);
    } catch {
      status.set(0, (status.get(0) ?? 0) + 1);
    }
    latencias.push(performance.now() - t0);
  }
}

const inicio = performance.now();
await Promise.all(Array.from({ length: CONCORRENCIA }, (_, i) => trabalhador(i)));
const segundos = (performance.now() - inicio) / 1000;

// métricas de cada instância: conflitos de trava e atraso da outbox
const metricas = await Promise.all(urls.map(async u => (await fetch(`${u}/metrics`)).text()));
const soma = (nome: string) =>
  metricas.reduce(
    (s, texto) => s + [...texto.matchAll(new RegExp(`^${nome}(?:\\{[^}]*\\})? (\\S+)$`, 'gm'))].reduce((a, m) => a + Number(m[1]), 0),
    0,
  );
const lagMax = Math.max(...metricas.map(t => Number(/^wagering_outbox_lag_seconds (\S+)$/m.exec(t)?.[1] ?? 0)));

// a outbox drena depois da carga?
const t0 = Date.now();
while ((await db`select count(*)::int as n from outbox_messages where published_at is null`)[0].n > 0 && Date.now() - t0 < 60_000)
  await Bun.sleep(200);
const drenouEm = (Date.now() - t0) / 1000;

const ordenadas = [...latencias].sort((a, b) => a - b);
const p = (q: number) => ordenadas[Math.min(ordenadas.length - 1, Math.floor(q * ordenadas.length))]!.toFixed(1);
const erros = [...status].filter(([s]) => s !== 200 && s !== 422).reduce((a, [, n]) => a + n, 0);
const consistentes = await Promise.all([quente, ...frias].map(w => walletState(w.id)));

console.log(`
Teste de carga — ${new Date().toISOString()}
Ambiente: ${process.platform}/${process.arch}, Bun ${Bun.version}; ${onde}; PostgreSQL 17 e LocalStack 4.14 no Docker
Metodologia: ${CONCORRENCIA} clientes concorrentes por ${DURACAO_S} s; ${Math.round(QUENTE * 100)}% das apostas numa wallet quente, o resto espalhado em ${WALLETS_FRIAS} wallets
Requisições: ${latencias.length} em ${segundos.toFixed(1)} s → ${(latencias.length / segundos).toFixed(0)} req/s
Latência (ms): p50 ${p(0.5)} · p95 ${p(0.95)} · p99 ${p(0.99)} · máx ${ordenadas.at(-1)!.toFixed(1)}
Status HTTP: ${[...status].map(([s, n]) => `${s}=${n}`).join(' ')}
Taxa de erro (fora 200/422): ${((erros / latencias.length) * 100).toFixed(2)}%
Conflitos de trava (lock timeout/deadlock): ${soma('wagering_lock_conflicts_total')}
Outbox: atraso máximo visto ${lagMax.toFixed(2)} s; pendências zeradas ${drenouEm.toFixed(1)} s depois do fim da carga
Invariante saldo == extrato: ${consistentes.every(s => s.balance === s.ledgerBalance && s.chained) ? 'ok em todas as wallets' : 'FALHOU'}
`);

await Promise.all(instancias.map(i => i.stop()));
process.exit(0);
