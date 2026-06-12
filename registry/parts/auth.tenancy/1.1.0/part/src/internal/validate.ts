import { TenancyError } from "./errors";
import type { Role } from "./types";

/**
 * Validation runs before any SQL: invalid input fails fast with zero database
 * interaction (contract invariant 2). Every check throws
 * TenancyError('invalid_input').
 */

const MAX_NAME = 256;
const MAX_ID = 256;
const ROLES: readonly Role[] = ["owner", "admin", "member"];

function invalid(detail: string): TenancyError {
  return new TenancyError("invalid_input", detail);
}

/** A non-empty, bounded text id (organization id or user id). */
function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`${label} is required and must be a non-empty string`);
  }
  if (value.length > MAX_ID) {
    throw invalid(`${label} exceeds ${MAX_ID} characters`);
  }
  return value;
}

export function validateOrganizationId(value: unknown): string {
  return requireId(value, "organizationId");
}

export function validateUserId(value: unknown): string {
  return requireId(value, "userId");
}

export function validateName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid("name is required and must be a non-empty string");
  }
  if (value.length > MAX_NAME) {
    throw invalid(`name exceeds ${MAX_NAME} characters`);
  }
  return value;
}

export function validateRole(value: unknown): Role {
  if (typeof value !== "string" || !ROLES.includes(value as Role)) {
    throw invalid(`role must be one of: ${ROLES.join(", ")}`);
  }
  return value as Role;
}

/** Total order on roles: owner(2) > admin(1) > member(0). */
const RANK: Record<Role, number> = { owner: 2, admin: 1, member: 0 };

/** True when `have` meets or exceeds the `required` role (contract invariant 6). */
export function roleMeets(have: Role, required: Role): boolean {
  return RANK[have] >= RANK[required];
}
