# Seams — auth.tenancy

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` (attested interior;
edits void the attestation and fail CI).

This part gives you **organizations, memberships, roles, and a row-level-scoping
authorization gate** over its own `auth_tenant_*` tables. It does **not** own
your users — the principal comes from `auth.session` (§4).

## 1. Environment

**None.** This part has no env and no secrets — the database connection is an
app-provided seam (§2), not a connection string the part reads. `partkit add`
scaffolds no `.env.example` entries for it.

Import with a tsconfig alias (recommended):

```jsonc
// tsconfig.json → compilerOptions
"paths": { "@parts/*": ["./parts/*/src"] }
```

```ts
import { tenancy, TenancyError } from "@parts/auth.tenancy";
```

Plain relative imports of `parts/auth.tenancy/src/index` work too. Never
deep-import `src/internal/**` (lint-enforced).

## 2. Run the migration, then wire the connection (the store seam)

`partkit add auth.tenancy` vendors
`parts/auth.tenancy/migrations/001-create-tenant-tables.sql`. Apply it before
first use:

```sh
partkit migrate     # creates auth_tenant_organization, auth_tenant_membership
```

The part imports no database driver. You hand it the same minimal `SqlExecutor`
shape `partkit migrate` uses — wire your `pg` Pool once
(`examples/pg-executor.ts`, outside the boundary, freely copyable):

```ts
import { tenancy } from "@parts/auth.tenancy";
import { pgExecutor } from "@/db/tenancy-executor"; // your copy of the example
const t = tenancy(pgExecutor(pool));
```

Constructing `tenancy(db)` performs no I/O; the database is touched only when a
method runs. Hand in a pooled client mid-transaction to make a membership change
commit together with the business write it accompanies.

## 3. Row-level scoping — the gate and the filter (the rule agents get wrong)

Multi-tenant isolation is two steps, and the bug is always skipping the first:

```ts
// 1. GATE: verify the principal belongs to the org (and meets a role).
//    Throws TenancyError("forbidden") otherwise — missing org and non-membership
//    are indistinguishable (no enumeration).
const scope = await tenancy(db).requireMembership({ organizationId, userId, role: "admin" });

// 2. SCOPE: filter YOUR OWN tables by the VERIFIED org id from the scope.
const rows = await appDb.query(
  "SELECT ... FROM your_table WHERE org_id = $1", [scope.organizationId],
);
```

Never trust a client-supplied `organizationId` until it has passed through
`requireMembership`. `organizationsForUser(userId)` gives the full set of org
ids a user may access — use it to populate an org switcher, never to widen a
single-org query. Full example: `examples/scoped-route.ts`.

## 4. The principal comes from auth.session (the composition seam)

`userId` everywhere in this interface is an **opaque auth.session principal**.
This part references it; it does not store, duplicate, or foreign-key your user
table (the `auth_tenant_*` tables have **no FK to `auth_user`** — the cross-part
boundary is preserved in the database).

Get the principal from `auth.session` at the request edge and pass it in:

```ts
import { requireSession } from "@parts/auth.session";
const { user } = await requireSession(headers);       // auth.session
await tenancy(db).requireMembership({ organizationId, userId: user.id, role: "admin" });
```

`contract.json` declares `requires: ["auth.session>=1"]` for exactly this
reason; `partkit plan` installs `auth.session` first.

## 5. Roles and the rules the part enforces

- Roles are ordered **owner > admin > member**. `requireMembership({ role })`
  treats `role` as the *minimum* (an owner passes an `admin` check).
- **An org is never ownerless:** `createOrganization` seeds the creator as
  `owner` atomically; `removeMember`/`setRole` refuse to remove or demote the
  *last* owner (`TenancyError("last_owner")` — promote a replacement first).
- **One membership per (org, user):** `addMember` on an existing member throws
  `already_member`; change roles with `setRole`.

## 6. Error handling

Every failure is a `TenancyError` with `.code`:

| code | when |
|---|---|
| `invalid_input` | blank name, empty/over-long id, unknown role (zero SQL issued) |
| `not_found` | `addMember` to an organization that does not exist |
| `already_member` | `addMember` for a user already in the org |
| `not_a_member` | `setRole`/`removeMember` for a user not in the org |
| `forbidden` | `requireMembership` failed — not a member, or under the required role |
| `last_owner` | would leave the org with no owner |
| `storage` | the executor (database) failed — generic message; raw error on `.cause` |

`requireMembership` is your authorization primitive — let `forbidden` map to
HTTP 403 (`examples/scoped-route.ts` shows the mapping).

## 7. What you must NOT do

- Edit or import anything under `src/internal/**`.
- `SELECT` or write `auth_tenant_organization` / `auth_tenant_membership`
  directly, or add a migration that foreign-keys them — they are interior; data
  exits through the interface, and joining your tables to them re-creates the
  boundary violation this part avoids. Store your own `org_id` (the value
  `createOrganization` returns) on your tables instead.
- Invent your own org/membership tables alongside this part (the anti-sprawl
  rule — one provider per capability; `partkit guard` enforces it).

## 8. Not in v1

Renaming organizations, slugs/unique handles, pending invitations (an invite is
a token flow that composes on `email.transactional`), and custom/role-beyond-
three are additive `1.x` minors. v1 is organizations + memberships + the three
fixed roles + the scoping gate.
