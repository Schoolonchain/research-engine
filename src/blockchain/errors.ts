export class BlockchainConnectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BlockchainConnectionError";
  }
}

export class BlockchainNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BlockchainNotFoundError";
  }
}

export class BlockchainValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BlockchainValidationError";
  }
}

export class BlockchainConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BlockchainConflictError";
  }
}
