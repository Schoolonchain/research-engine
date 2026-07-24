export class KnowledgeValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "KnowledgeValidationError";
  }
}

export class KnowledgeNotFoundError extends Error {
  public constructor(message = "Knowledge entity not found") {
    super(message);
    this.name = "KnowledgeNotFoundError";
  }
}

export class KnowledgeConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "KnowledgeConflictError";
  }
}

export class UnsafeSourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsafeSourceError";
  }
}
