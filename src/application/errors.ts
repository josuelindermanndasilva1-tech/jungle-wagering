// Erros que a aplicação devolve ao chamador, cada um com um status HTTP próprio (ver http/error.filter.ts).

/** Payload inválido: o provedor precisa corrigir antes de reenviar. HTTP 400. */
export class InvalidRequestError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

/** Conflito de estado: mesma chave com payload diferente, wallet duplicada... Reenviar igual não resolve. HTTP 409. */
export class ConflictError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
