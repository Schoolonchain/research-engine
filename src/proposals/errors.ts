export class ProposalNotFoundError extends Error {
  public constructor() {
    super("Proposal not found");
    this.name = "ProposalNotFoundError";
  }
}

export class ProposalForbiddenError extends Error {
  public constructor(message = "Proposal action is not permitted") {
    super(message);
    this.name = "ProposalForbiddenError";
  }
}

export class ProposalAuthenticationRequiredError extends Error {
  public constructor() {
    super("Authentication required");
    this.name = "ProposalAuthenticationRequiredError";
  }
}

export class ProposalConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProposalConflictError";
  }
}

export class ProposalValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProposalValidationError";
  }
}
