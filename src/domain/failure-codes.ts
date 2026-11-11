/**
 * Taxonomia estável dos códigos de falha (REJECTED e FAILED). Cada código diz ao provedor o que fazer:
 * reenviar a mesma chave sempre devolve o mesmo resultado, então corrigir significa mandar uma transação nova.
 */
export const FailureCode = {
  /** BET maior que o saldo. O provedor não reenvia; a aposta não aconteceu. */
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  /** ROLLBACK que deixaria o saldo negativo (o crédito revertido já foi gasto). Exige ação operacional. */
  RollbackInsufficientFunds: 'ROLLBACK_INSUFFICIENT_FUNDS',
  /** walletId inexistente. Corrigir o payload. */
  WalletNotFound: 'WALLET_NOT_FOUND',
  /** A wallet existe, mas pertence a outro player. Corrigir o payload. */
  WalletPlayerMismatch: 'WALLET_PLAYER_MISMATCH',
  /** Moeda da operação diferente da moeda da wallet. Corrigir o payload. */
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  /** A referência não chegou dentro do prazo de reprocessamento. */
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  /** A referência existe, mas foi rejeitada ou falhou: não há o que reverter. */
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  /** A referência é de outro player, wallet, moeda ou rodada. */
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  /** Tipo de referência não permitido (ex.: REFUND de um WIN). */
  InvalidReferenceKind: 'INVALID_REFERENCE_KIND',
  /** Valor da reversão diferente do valor da referência (reversão parcial está fora do escopo). */
  AmountMismatch: 'AMOUNT_MISMATCH',
  /** A referência já foi revertida por um REFUND ou ROLLBACK processado. */
  AlreadyReversed: 'ALREADY_REVERSED',
  /** Erro permanente inesperado ao reprocessar (status FAILED, auditável). */
  InternalError: 'INTERNAL_ERROR',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];
