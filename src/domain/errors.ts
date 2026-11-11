// Erros de domínio: regra violada ou uso errado do modelo. Nunca representam falha de infraestrutura.
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(a: string, b: string) {
    super('CURRENCY_MISMATCH', `moedas diferentes: ${a} e ${b}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super('INSUFFICIENT_FUNDS', 'saldo insuficiente');
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(from: string, to: string) {
    super('INVALID_TRANSACTION_STATE', `transição inválida: ${from} -> ${to}`);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super('INVALID_LEDGER_ENTRY', message);
  }
}

export class InvalidTransactionError extends DomainError {
  constructor(message: string) {
    super('INVALID_TRANSACTION', message);
  }
}
