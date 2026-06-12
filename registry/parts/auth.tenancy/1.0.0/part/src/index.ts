/**
 * auth.tenancy — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 *
 * Organizations, memberships, and roles with a row-level-scoping authorization
 * gate, over the part-owned auth_tenant_* tables. The connection is an
 * app-provided SqlExecutor seam (no driver, no env); the principal (user id)
 * flows in from auth.session at the app's seam and is referenced, never owned.
 */
import { randomUUID } from "node:crypto";
import { TenancyError } from "./internal/errors";
import {
  ADD_MEMBER_SQL,
  count,
  CREATE_ORG_SQL,
  DELETE_ORG_SQL,
  GET_MEMBERSHIP_SQL,
  GET_ORG_SQL,
  LIST_MEMBERS_SQL,
  ORGS_FOR_USER_SQL,
  REMOVE_MEMBER_SQL,
  rowToMembership,
  rowToOrganization,
  SET_ROLE_SQL,
} from "./internal/sql";
import type {
  AddMemberInput,
  CreateOrganizationInput,
  Membership,
  MembershipRef,
  Organization,
  RequireMembershipInput,
  Role,
  SetRoleInput,
  SqlExecutor,
  Tenancy,
} from "./internal/types";
import {
  roleMeets,
  validateName,
  validateOrganizationId,
  validateRole,
  validateUserId,
} from "./internal/validate";

export { TenancyError } from "./internal/errors";
export type { TenancyErrorCode } from "./internal/errors";
export type {
  AddMemberInput,
  CreateOrganizationInput,
  Membership,
  MembershipRef,
  Organization,
  RequireMembershipInput,
  Role,
  SetRoleInput,
  SqlExecutor,
  Tenancy,
} from "./internal/types";

/**
 * Bind the tenancy operations to a database connection (the SqlExecutor seam).
 * Constructing it performs no I/O and never throws — inputs are validated, and
 * the database touched, only when a method runs (contract invariant 1,
 * serverless-safe). Pass a per-request executor from your pool.
 */
export function tenancy(db: SqlExecutor): Tenancy {
  return {
    createOrganization: (input) => createOrganization(db, input),
    getOrganization: (organizationId) => getOrganization(db, organizationId),
    deleteOrganization: (organizationId) => deleteOrganization(db, organizationId),
    addMember: (input) => addMember(db, input),
    setRole: (input) => setRole(db, input),
    removeMember: (input) => removeMember(db, input),
    getMembership: (input) => getMembership(db, input),
    requireMembership: (input) => requireMembership(db, input),
    listMembers: (organizationId) => listMembers(db, organizationId),
    organizationsForUser: (userId) => organizationsForUser(db, userId),
  };
}

/** Run one statement, wrapping any driver error as a redacted storage error. */
async function run(
  db: SqlExecutor,
  sql: string,
  params: readonly unknown[],
  op: string,
): Promise<{ rows: Record<string, unknown>[] }> {
  try {
    return await db.query(sql, params);
  } catch (e) {
    throw new TenancyError("storage", `failed to ${op}`, { cause: e });
  }
}

async function createOrganization(
  db: SqlExecutor,
  input: CreateOrganizationInput,
): Promise<Organization> {
  const name = validateName(input.name);
  const ownerUserId = validateUserId(input.ownerUserId);
  const id = randomUUID();
  const result = await run(db, CREATE_ORG_SQL, [id, name, ownerUserId], "create organization");
  const row = result.rows[0];
  if (row === undefined) {
    throw new TenancyError(
      "storage",
      "create organization returned no row — is the auth_tenant migration applied?",
    );
  }
  return rowToOrganization(row);
}

async function getOrganization(
  db: SqlExecutor,
  organizationId: string,
): Promise<Organization | null> {
  const id = validateOrganizationId(organizationId);
  const result = await run(db, GET_ORG_SQL, [id], "read organization");
  const row = result.rows[0];
  return row === undefined ? null : rowToOrganization(row);
}

async function deleteOrganization(db: SqlExecutor, organizationId: string): Promise<void> {
  const id = validateOrganizationId(organizationId);
  await run(db, DELETE_ORG_SQL, [id], "delete organization");
}

async function addMember(db: SqlExecutor, input: AddMemberInput): Promise<Membership> {
  const organizationId = validateOrganizationId(input.organizationId);
  const userId = validateUserId(input.userId);
  const role: Role = input.role === undefined ? "member" : validateRole(input.role);
  const result = await run(db, ADD_MEMBER_SQL, [organizationId, userId, role], "add member");
  const row = result.rows[0];
  if (row === undefined) {
    throw new TenancyError("storage", "add member returned no row — is the auth_tenant migration applied?");
  }
  if (count(row, "org_exists") === 0) {
    throw new TenancyError("not_found", "organization does not exist");
  }
  if (count(row, "inserted") === 0) {
    throw new TenancyError("already_member", "user is already a member of this organization");
  }
  return rowToMembership(row);
}

async function setRole(db: SqlExecutor, input: SetRoleInput): Promise<Membership> {
  const organizationId = validateOrganizationId(input.organizationId);
  const userId = validateUserId(input.userId);
  const role = validateRole(input.role);
  const result = await run(db, SET_ROLE_SQL, [organizationId, userId, role], "set role");
  const row = result.rows[0];
  if (row === undefined) {
    throw new TenancyError("storage", "set role returned no row — is the auth_tenant migration applied?");
  }
  if (count(row, "existed") === 0) {
    throw new TenancyError("not_a_member", "user is not a member of this organization");
  }
  if (count(row, "updated") === 0) {
    throw new TenancyError(
      "last_owner",
      "cannot demote the last owner — promote another member to owner first",
    );
  }
  return rowToMembership(row);
}

async function removeMember(db: SqlExecutor, input: MembershipRef): Promise<void> {
  const organizationId = validateOrganizationId(input.organizationId);
  const userId = validateUserId(input.userId);
  const result = await run(db, REMOVE_MEMBER_SQL, [organizationId, userId], "remove member");
  const row = result.rows[0];
  if (row === undefined) {
    throw new TenancyError("storage", "remove member returned no row — is the auth_tenant migration applied?");
  }
  if (count(row, "existed") === 0) {
    throw new TenancyError("not_a_member", "user is not a member of this organization");
  }
  if (count(row, "deleted") === 0) {
    throw new TenancyError(
      "last_owner",
      "cannot remove the last owner — promote another member to owner first",
    );
  }
}

async function getMembership(
  db: SqlExecutor,
  input: MembershipRef,
): Promise<Membership | null> {
  const organizationId = validateOrganizationId(input.organizationId);
  const userId = validateUserId(input.userId);
  const result = await run(db, GET_MEMBERSHIP_SQL, [organizationId, userId], "read membership");
  const row = result.rows[0];
  return row === undefined ? null : rowToMembership(row);
}

/**
 * The row-level-scoping gate (contract invariant 5). Returns the caller's
 * membership when they belong to the organization (and meet `role`); throws
 * TenancyError("forbidden") otherwise. The forbidden path is identical whether
 * the organization is missing or the user is simply not a member — no
 * enumeration. Obtaining a scope IS the membership check.
 */
async function requireMembership(
  db: SqlExecutor,
  input: RequireMembershipInput,
): Promise<Membership> {
  const organizationId = validateOrganizationId(input.organizationId);
  const userId = validateUserId(input.userId);
  const required: Role | null = input.role === undefined ? null : validateRole(input.role);
  const result = await run(db, GET_MEMBERSHIP_SQL, [organizationId, userId], "check membership");
  const row = result.rows[0];
  if (row === undefined) {
    throw new TenancyError("forbidden", "not a member of this organization");
  }
  const membership = rowToMembership(row);
  if (required !== null && !roleMeets(membership.role, required)) {
    throw new TenancyError("forbidden", `requires role "${required}" or higher`);
  }
  return membership;
}

async function listMembers(db: SqlExecutor, organizationId: string): Promise<Membership[]> {
  const id = validateOrganizationId(organizationId);
  const result = await run(db, LIST_MEMBERS_SQL, [id], "list members");
  return result.rows.map(rowToMembership);
}

async function organizationsForUser(db: SqlExecutor, userId: string): Promise<Membership[]> {
  const id = validateUserId(userId);
  const result = await run(db, ORGS_FOR_USER_SQL, [id], "list organizations for user");
  return result.rows.map(rowToMembership);
}
