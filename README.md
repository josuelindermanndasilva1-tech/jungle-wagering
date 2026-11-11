# Distributed Wagering Processor

Serviço que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de vários provedores de jogos,
mantendo saldo e extrato corretos mesmo com mensagens **duplicadas**, **fora de ordem** e **simultâneas**, em **várias instâncias**.

Stack: **Bun 1.3** · **TypeScript estrito** · **NestJS 12** · **PostgreSQL 17** · **MikroORM 7** · **SQS** (LocalStack) · **Docker Compose**.

As decisões técnicas, os trade-offs e as limitações estão no [ARCHITECTURE.md](ARCHITECTURE.md).

> **Uso de IA.** Este projeto foi desenvolvido com apoio de IA (Claude, da Anthropic) como par de programação.

## Requisitos

- [Bun](https://bun.sh) 1.3 ou mais novo
- Docker com Docker Compose

## Subir e rodar

```bash
bun install
docker compose up -d            # PostgreSQL (porta 5434) e LocalStack com SQS (porta 4566)
bun run db:migrate              # cria as tabelas, constraints e triggers
bun run start                   # API na porta 3000 + consumidor SQS + publicador da outbox + worker de pendentes
```

A aplicação cria as filas que faltarem na primeira chamada à SQS (em produção isso é da infraestrutura: `SQS_CREATE_QUEUES=false`).

**Três réplicas pelo Compose**, na mesma rede do banco (API nas portas 3001, 3002 e 3003):

```bash
docker compose --profile app up -d --build
```

O LocalStack está fixado na versão **4.14.0**, a última que roda SQS sem token de licença (as versões 2026.x exigem `LOCALSTACK_AUTH_TOKEN`).
As portas 5434 e 4566 no host podem ser trocadas no `docker-compose.yml` (lembre de ajustar `DB_PORT`/`SQS_ENDPOINT`).

### Variáveis de ambiente

Todas têm padrão compatível com o `docker-compose.yml` ([src/config.ts](src/config.ts)).

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3000` | porta da API |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `localhost` / `5434` / `wagering` / `wagering` / `wagering` | PostgreSQL |
| `DB_POOL_MAX` | `20` | conexões por instância |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima pela trava de uma wallet; passou disso, 503 |
| `SQS_ENDPOINT` | `http://localhost:4566` | LocalStack |
| `SQS_WAGER_QUEUE` / `SQS_DLQ` / `SQS_EVENTS_QUEUE` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` / `wagering-events.fifo` | filas |
| `SQS_MAX_RECEIVE_COUNT` | `5` | recebimentos antes da DLQ (redrive policy) |
| `SQS_RETRY_BASE_DELAY_S` | `2` | backoff da mensagem com falha transitória: base × 2^(n-1), até 5 min |
| `WORKERS` | `consumer,outbox,pending` | workers desta instância (vazio = só API) |
| `PENDING_MAX_ATTEMPTS` / `PENDING_BASE_DELAY_MS` | `8` / `1000` | reprocessamento de referência ausente |
| `LOG_LEVEL` | — | `silent` desliga os logs |

## Testes

Unidade (sem infraestrutura):

```bash
bun run test:unit
```

Tudo, com PostgreSQL e LocalStack **reais** (`docker compose up -d` antes). Os testes usam um banco (`wagering_test`) e filas (`test-*`) próprios, recriados a cada execução:

```bash
bun run test                 # unidade + integração + concorrência (~70 s)
bun run test:integration     # schema, atomicidade, API, mensageria
bun run test:concurrency     # os 8 cenários de concorrência, inclusive 3 processos e kill -9
bun run test:load            # teste de carga (diferencial): sobe 3 instâncias e mede
bun run typecheck            # tsc --noEmit, modo estrito
```

## API

| Método | Rota | |
|---|---|---|
| `POST` | `/wallets` | cria wallet (`playerId`, `initialBalance`) |
| `GET` | `/wallets/:walletId` | saldo e version |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | extrato paginado, cursor opaco e estável |
| `POST` | `/wallets/:walletId/reconciliation` | saldo guardado × saldo reconstruído pelo extrato |
| `POST` | `/wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | transação pelo id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor |
| `GET` | `/health/live`, `/health/ready` | liveness; readiness (PostgreSQL e SQS) — sem autenticação |
| `GET` | `/metrics` | métricas no formato Prometheus |

Dinheiro é sempre `{ "amount": "25.00", "currency": "BRL" }`: string decimal com até 2 casas na entrada e exatamente 2 na saída.

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
       "walletId":"<id da wallet>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

### Status HTTP

O mesmo mapeamento em todos os endpoints, para o provedor decidir sem ler a mensagem:

| Status | Quando | O provedor deve |
|---|---|---|
| `200` | transação `PROCESSED` (também no replay, com `idempotentReplay: true`) | seguir |
| `201` | wallet criada | seguir |
| `202` | `PENDING_REFERENCE`: aceita, esperando a transação referenciada | consultar depois (ou reenviar a mesma chave) |
| `400` | payload inválido, `Idempotency-Key` ausente, `OPENING` | corrigir e mandar uma transação nova |
| `404` | wallet ou transação inexistente (consultas) | — |
| `409` | mesma chave com outro payload (`IDEMPOTENCY_KEY_CONFLICT`), id externo reusado com outra chave (`EXTERNAL_ID_CONFLICT`), wallet duplicada | não reenviar igual |
| `422` | `REJECTED` por regra de negócio, com `failureCode` | não reenviar a mesma chave |
| `503` | falha transitória de infraestrutura (banco indisponível, fila longa na trava da wallet), com `Retry-After` | **reenviar a mesma requisição** |
| `500` | erro inesperado, ou transação `FAILED` | acionar a operação |

### Códigos de falha (`failureCode`)

| Código | Significado |
|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo |
| `ROLLBACK_INSUFFICIENT_FUNDS` | ROLLBACK que deixaria o saldo negativo (o crédito revertido já foi gasto) — exige ação operacional |
| `WALLET_NOT_FOUND` / `WALLET_PLAYER_MISMATCH` / `CURRENCY_MISMATCH` | wallet inexistente, de outro player, ou de outra moeda |
| `REFERENCE_NOT_FOUND` | a referência não chegou dentro do prazo de reprocessamento |
| `REFERENCE_NOT_PROCESSED` | a referência foi rejeitada: não há o que reverter |
| `REFERENCE_MISMATCH` | a referência é de outro player, wallet, moeda ou rodada |
| `INVALID_REFERENCE_KIND` | tipo de referência não permitido (ex.: REFUND de um WIN) |
| `AMOUNT_MISMATCH` | valor da reversão diferente do valor da referência |
| `ALREADY_REVERSED` | a referência já foi revertida |
| `INTERNAL_ERROR` | erro permanente inesperado ao reprocessar (`FAILED`) |

## SQS

- `wager-transactions.fifo` — entrada. Mensagem `{ messageId, type: "WagerTransactionRequested", occurredAt, data }`, com o mesmo `data` da API mais `idempotencyKey`. `MessageGroupId` = `walletId`.
- `wager-transactions-dlq.fifo` — mensagens inválidas, em conflito ou que esgotaram as tentativas, com o atributo `reason`.
- `wagering-events.fifo` — eventos de integração publicados pela outbox (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`). `MessageGroupId` = `walletId`, `MessageDeduplicationId` = `eventId`.

## Estrutura

```
src/
  domain/            Money, Wallet, WagerTransaction, WalletLedgerEntry, regras (settlement), eventos, inbox/outbox — sem framework
  application/       casos de uso (ProcessWager, CreateWallet, ReconcileWallet), portas, validação de entrada
  infrastructure/    MikroORM + SQL, migrations, SQS (consumidor, publisher, workers), logs e métricas
  http/              controllers, filtro de erros, guard de autenticação (ponto de extensão)
test/
  unit/              regras de domínio
  integration/       schema e constraints, atomicidade, contrato da API, inbox/DLQ/outbox
  concurrency/       os 8 cenários obrigatórios
  load/              teste de carga
```
