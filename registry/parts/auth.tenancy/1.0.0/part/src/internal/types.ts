/**
 * The driver-free database seam — the same minimal `node-postgres` Client/Pool
 * shape `partkit migrate` uses. The app wires its own `pg` Pool to this; the
 * part imports no driver (contract invariant 10). Wiring example: seams.md §2.
 *
 * Compound operations are single statements (data-modifying CTEs), so the part
 * is correct even when this executor is a pooled connection rather than an
 * explicit transaction (seams.md §3).
 */
export interface SqlExecutor {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Role, ordered owner > admin > member (contract invariant 6). */
export type Role = "owner" | "admin" | "member";

/** A tenant. `id` is server-assigned by the part, not caller-settable. */
export interface Organization {
  /** Server-assigned, URL-safe handle (a UUID). */
  id: string;
  name: string;
  /** Server-assigned creation time. */
  createdAt: Date;
}

/** A user's place in an organization — the unit of authorization. */
export interface Membership {
  organizationId: string;
  /** The principal, by reference: an opaque auth.session user id (seams.md §4). */
  userId: string;
  role: Role;
  createdAt: Date;
}

/** What createOrganization needs: a name and the user who will own it. */
export interface CreateOrganizationInput {
  name: string;
  /** Becomes the first member, with role `owner` — so the org is never ownerless. */
  ownerUserId: string;
}

/** Identifies a single membership (an org + a user). */
export interface MembershipRef {
  organizationId: string;
  userId: string;
}

/** Add a user to an organization. `role` defaults to `member`. */
export interface AddMemberInput extends MembershipRef {
  role?: Role;
}

/** Change an existing member's role. */
export interface SetRoleInput extends MembershipRef {
  role: Role;
}

/** The authorization gate. `role`, when given, is the MINIMUM role required. */
export interface RequireMembershipInput extends MembershipRef {
  /** Minimum role (owner > admin > member); omitted = any membership suffices. */
  role?: Role;
}

/**
 * The capability surface, bound to one SqlExecutor by `tenancy(db)`. Every
 * method validates its input before touching the database (invariant 2) and
 * surfaces failures as TenancyError (invariant 1).
 */
export interface Tenancy {
  /** Create an org and its owner membership atomically; never ownerless. */
  createOrganization(input: CreateOrganizationInput): Promise<Organization>;
  /** Read one organization, or null. */
  getOrganization(organizationId: string): Promise<Organization | null>;
  /** Delete an org; its memberships cascade away (invariant 9). */
  deleteOrganization(organizationId: string): Promise<void>;

  /** Add a member; rejects a duplicate or an unknown org with a typed error. */
  addMember(input: AddMemberInput): Promise<Membership>;
  /** Change a member's role; will not demote the last owner (invariant 7). */
  setRole(input: SetRoleInput): Promise<Membership>;
  /** Remove a member; will not remove the last owner (invariant 7). */
  removeMember(input: MembershipRef): Promise<void>;

  /** Read one membership, or null. */
  getMembership(input: MembershipRef): Promise<Membership | null>;
  /**
   * The row-level-scoping gate (invariant 5): returns the membership when the
   * user belongs to the org (and meets `role`), throws TenancyError('forbidden')
   * otherwise. Obtaining a scope IS the membership check.
   */
  requireMembership(input: RequireMembershipInput): Promise<Membership>;

  /** All members of one organization (invariant 8). */
  listMembers(organizationId: string): Promise<Membership[]>;
  /** All organizations a user belongs to, with their role — the scope source. */
  organizationsForUser(userId: string): Promise<Membership[]>;
}
