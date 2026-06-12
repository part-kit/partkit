/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * The organization + membership lifecycle: create a team, invite people, change
 * roles. The part enforces the rules you would otherwise get wrong (an org is
 * never ownerless; the last owner cannot be removed or demoted).
 *
 * After copying, change the imports to your alias (seams.md §1):
 *   import { tenancy } from "@parts/auth.tenancy";
 */
import { tenancy, type Membership, type Organization, type Role, type SqlExecutor } from "../src/index";

/** Create a team. The founder becomes the first owner atomically. */
export async function createTeam(
  db: SqlExecutor,
  name: string,
  founderUserId: string,
): Promise<Organization> {
  return tenancy(db).createOrganization({ name, ownerUserId: founderUserId });
}

/** Invite a user to an org. `userId` is an auth.session principal (seams.md §4). */
export async function inviteMember(
  db: SqlExecutor,
  organizationId: string,
  userId: string,
  role: Role = "member",
): Promise<Membership> {
  // Throws TenancyError("already_member") if they are already in, or
  // ("not_found") if the org does not exist.
  return tenancy(db).addMember({ organizationId, userId, role });
}

/**
 * Promote or demote a member. setRole refuses to demote the last owner — promote
 * a replacement first, or you will get TenancyError("last_owner").
 */
export async function changeRole(
  db: SqlExecutor,
  organizationId: string,
  userId: string,
  role: Role,
): Promise<Membership> {
  return tenancy(db).setRole({ organizationId, userId, role });
}
