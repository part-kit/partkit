import type { Membership, Organization, Role } from "./types";

/**
 * Every statement is a CONSTANT string with positional placeholders — no input
 * is ever concatenated into SQL, so metacharacters in names and ids are data,
 * never code (contract invariant 10). Every statement references only the
 * part-owned `auth_tenant_organization` / `auth_tenant_membership` tables.
 *
 * Compound operations are single data-modifying CTE statements, not multiple
 * round-trips. Postgres runs every data-modifying CTE exactly once and to
 * completion, so create-org-with-owner, the last-owner-guarded remove/demote,
 * and add-member-to-existing-org are each ATOMIC even when the SqlExecutor is a
 * pooled connection rather than an explicit transaction (no BEGIN/COMMIT to
 * straddle two connections from the pool).
 */

/**
 * Create the organization and its owner membership in one statement, so an org
 * is never ownerless (invariant 3). `new_owner` is referenced in the final FROM
 * so it is guaranteed to run; the result is the stored organization.
 * Params: $1 id, $2 name, $3 ownerUserId.
 */
export const CREATE_ORG_SQL = `WITH new_org AS (
  INSERT INTO auth_tenant_organization (id, name)
  VALUES ($1, $2)
  RETURNING id, name, created_at
), new_owner AS (
  INSERT INTO auth_tenant_membership (organization_id, user_id, role)
  SELECT id, $3, 'owner' FROM new_org
  RETURNING organization_id
)
SELECT new_org.id, new_org.name, new_org.created_at
FROM new_org, new_owner`;

/** Params: $1 organizationId. */
export const GET_ORG_SQL = `SELECT id, name, created_at
FROM auth_tenant_organization
WHERE id = $1`;

/** Memberships cascade via the FK; idempotent (0 rows when absent). Params: $1 id. */
export const DELETE_ORG_SQL = `DELETE FROM auth_tenant_organization
WHERE id = $1`;

/**
 * Add a member, distinguishing three outcomes in one statement: the org does
 * not exist (org_exists 0 → not_found), the user is already a member
 * (inserted 0 → already_member), or success (inserted 1). The composite PK
 * makes the ON CONFLICT a structural no-op, never a second row (invariant 4).
 * Params: $1 organizationId, $2 userId, $3 role.
 */
export const ADD_MEMBER_SQL = `WITH org AS (
  SELECT id FROM auth_tenant_organization WHERE id = $1
), ins AS (
  INSERT INTO auth_tenant_membership (organization_id, user_id, role)
  SELECT id, $2, $3 FROM org
  ON CONFLICT (organization_id, user_id) DO NOTHING
  RETURNING organization_id, user_id, role, created_at
)
SELECT
  (SELECT count(*) FROM org)            AS org_exists,
  (SELECT count(*) FROM ins)            AS inserted,
  (SELECT organization_id FROM ins)     AS organization_id,
  (SELECT user_id FROM ins)             AS user_id,
  (SELECT role FROM ins)                AS role,
  (SELECT created_at FROM ins)          AS created_at`;

/**
 * Change a member's role, refusing to demote the last owner (invariant 7). The
 * guard reads the owner count and the member's current role in the same
 * statement as the UPDATE. Outcomes: not a member (existed 0), last-owner block
 * (updated 0), or success (updated 1). Params: $1 organizationId, $2 userId,
 * $3 newRole.
 */
export const SET_ROLE_SQL = `WITH m AS (
  SELECT role,
    (SELECT count(*) FROM auth_tenant_membership
     WHERE organization_id = $1 AND role = 'owner') AS owner_count
  FROM auth_tenant_membership
  WHERE organization_id = $1 AND user_id = $2
), upd AS (
  UPDATE auth_tenant_membership
  SET role = $3
  WHERE organization_id = $1 AND user_id = $2
    AND NOT ((SELECT role FROM m) = 'owner' AND $3 <> 'owner' AND (SELECT owner_count FROM m) <= 1)
  RETURNING organization_id, user_id, role, created_at
)
SELECT
  (SELECT count(*) FROM m)              AS existed,
  (SELECT count(*) FROM upd)            AS updated,
  (SELECT organization_id FROM upd)     AS organization_id,
  (SELECT user_id FROM upd)             AS user_id,
  (SELECT role FROM upd)                AS role,
  (SELECT created_at FROM upd)          AS created_at`;

/**
 * Remove a member, refusing to remove the last owner (invariant 7). Outcomes:
 * not a member (existed 0), last-owner block (deleted 0), or success
 * (deleted 1). Params: $1 organizationId, $2 userId.
 */
export const REMOVE_MEMBER_SQL = `WITH m AS (
  SELECT role,
    (SELECT count(*) FROM auth_tenant_membership
     WHERE organization_id = $1 AND role = 'owner') AS owner_count
  FROM auth_tenant_membership
  WHERE organization_id = $1 AND user_id = $2
), del AS (
  DELETE FROM auth_tenant_membership
  WHERE organization_id = $1 AND user_id = $2
    AND NOT ((SELECT role FROM m) = 'owner' AND (SELECT owner_count FROM m) <= 1)
  RETURNING user_id
)
SELECT
  (SELECT count(*) FROM m)   AS existed,
  (SELECT count(*) FROM del) AS deleted`;

/** Params: $1 organizationId, $2 userId. */
export const GET_MEMBERSHIP_SQL = `SELECT organization_id, user_id, role, created_at
FROM auth_tenant_membership
WHERE organization_id = $1 AND user_id = $2`;

/** Members of one org, oldest-first (invariant 8). Params: $1 organizationId. */
export const LIST_MEMBERS_SQL = `SELECT organization_id, user_id, role, created_at
FROM auth_tenant_membership
WHERE organization_id = $1
ORDER BY created_at, user_id`;

/** Orgs a user belongs to, oldest-first (invariant 8). Params: $1 userId. */
export const ORGS_FOR_USER_SQL = `SELECT organization_id, user_id, role, created_at
FROM auth_tenant_membership
WHERE user_id = $1
ORDER BY created_at, organization_id`;

/** A `count(*)` column comes back from pg as a bigint string; parse to a number. */
export function count(row: Record<string, unknown>, key: string): number {
  return Number(row[key]);
}

/** Map a raw org row to the public Organization (timestamptz → Date). */
export function rowToOrganization(row: Record<string, unknown>): Organization {
  const created = row["created_at"];
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    createdAt: created instanceof Date ? created : new Date(String(created)),
  };
}

/** Map a raw membership row to the public Membership. */
export function rowToMembership(row: Record<string, unknown>): Membership {
  const created = row["created_at"];
  return {
    organizationId: String(row["organization_id"]),
    userId: String(row["user_id"]),
    // The DB CHECK constraint guarantees one of the three role values.
    role: String(row["role"]) as Role,
    createdAt: created instanceof Date ? created : new Date(String(created)),
  };
}
