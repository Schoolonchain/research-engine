export class ParticipationAuthenticationRequiredError extends Error {
  public constructor() {
    super("Participation identity required");
    this.name = "ParticipationAuthenticationRequiredError";
  }
}

export class ParticipationValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ParticipationValidationError";
  }
}

export class ParticipationConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ParticipationConflictError";
  }
}

export class DuplicateSupportError extends Error {
  public constructor() {
    super("Subject already supports this proposal");
    this.name = "DuplicateSupportError";
  }
}

export class SupportNotFoundError extends Error {
  public constructor() {
    super("Active support not found");
    this.name = "SupportNotFoundError";
  }
}

export class ParticipationRateLimitError extends Error {
  public constructor(public readonly retryAfterSeconds: number) {
    super("Participation rate limit exceeded");
    this.name = "ParticipationRateLimitError";
  }
}

export class ParticipationContentionError extends Error {
  public constructor() {
    super("Participation could not be committed after bounded retries");
    this.name = "ParticipationContentionError";
  }
}
