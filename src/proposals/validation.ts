import {
  PROPOSAL_VISIBILITIES,
  type CreateProposalInput,
  type ProposalVisibility,
  type UpdateProposalInput,
} from "./model.js";
import { ProposalValidationError } from "./errors.js";

function text(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string") {
    throw new ProposalValidationError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ProposalValidationError(
      `${field} must contain ${minimum} to ${maximum} characters`,
    );
  }
  return normalized;
}

function visibility(value: unknown): ProposalVisibility {
  if (
    typeof value !== "string" ||
    !PROPOSAL_VISIBILITIES.includes(value as ProposalVisibility)
  ) {
    throw new ProposalValidationError(
      `visibility must be one of: ${PROPOSAL_VISIBILITIES.join(", ")}`,
    );
  }
  return value as ProposalVisibility;
}

export function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ProposalValidationError(
      "expectedVersion must be a positive integer",
    );
  }
  return Number(value);
}

export function validateCreateProposal(
  input: CreateProposalInput,
): Required<CreateProposalInput> {
  return Object.freeze({
    title: text(input.title, "title", 1, 240),
    centralQuestion: text(
      input.centralQuestion,
      "centralQuestion",
      1,
      2_000,
    ),
    description:
      input.description === undefined
        ? ""
        : text(input.description, "description", 0, 20_000),
    visibility:
      input.visibility === undefined ? "PUBLIC" : visibility(input.visibility),
  });
}

export function validateUpdateProposal(
  input: UpdateProposalInput,
): UpdateProposalInput {
  const result: {
    expectedVersion: number;
    title?: string;
    centralQuestion?: string;
    description?: string;
    visibility?: ProposalVisibility;
  } = {
    expectedVersion: expectedVersion(input.expectedVersion),
  };

  if (input.title !== undefined) {
    result.title = text(input.title, "title", 1, 240);
  }
  if (input.centralQuestion !== undefined) {
    result.centralQuestion = text(
      input.centralQuestion,
      "centralQuestion",
      1,
      2_000,
    );
  }
  if (input.description !== undefined) {
    result.description = text(input.description, "description", 0, 20_000);
  }
  if (input.visibility !== undefined) {
    result.visibility = visibility(input.visibility);
  }

  if (Object.keys(result).length === 1) {
    throw new ProposalValidationError("At least one field must be updated");
  }
  return Object.freeze(result);
}

export function validateReason(value: unknown): string {
  return text(value, "reason", 1, 2_000);
}

