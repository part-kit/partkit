# auth.tenancy — SPEC

Organizations, memberships, and roles with a **row-level-scoping authorization
gate**, over part-owned Postgres tables, through a contract-stable interface and
a driver-free `SqlExecutor` seam. v1 scope is **organizations + memberships +
three fixed roles + the scoping gate**, with the tenancy business rules
(never-ownerless, last-owner protection, one-membership-per-user) enforced in
the database, not merely in the API.

## Design decisions

- **The connection is a seam, not env or a driver** (the `audit.log`
  precedent). The part imports no `pg` and reads no `DATABASE_URL`; the app hands
  in the same minimal `SqlExecutor` shape `partkit migrate` uses. So this part
  ships **zero adapters and zero env**, owns `auth_tenant_organization` +
  `auth_tenant_membership`, and runs on the app's connection/transaction — a
  membership change can commit in the same transaction as the business write it
  accompanies. This is the **portability** bar (§1.9): it runs on plain Node +
  Postgres a team self-hosts, with no managed vendor anywhere.

- **The principal is referenced, never owned.** `user_id` is an opaque
  `auth.session` id supplied by the app; there is deliberately **no foreign key**
  to `auth_user`. A cross-part FK would couple two part interiors and break the
  database boundary (docs/02 §6 — part migrations touch only their own tables).
  The part therefore declares `requires: ["auth.session>=1"]` (the first part to
  exercise the requires edge) and documents the principal as a **composition
  seam**: the user id flows in from `getSession` at the app's edge
  (`seams.md` §4, `examples/scoped-route.ts`).

- **`requireMembership` is the row-level-scoping primitive — the thing agents
  get wrong most expensively.** Obtaining a scope *is* the membership check: you
  cannot get an organization id to filter by without proving membership (and an
  optional minimum role) first. It is **enumeration-safe** — a missing
  organization and a non-membership both return `forbidden`, indistinguishable to
  the caller — so the gate cannot be used to probe which orgs exist. `seams.md`
  §3 documents the gate-then-filter pattern; the part cannot write the app's
  `WHERE org_id = $1`, but it makes the unsafe path impossible to reach without
  the gate.

- **The tenancy business rules are enforced atomically, through a pooled seam.**
  The `SqlExecutor` exposes only `query` — the part cannot assume a dedicated
  connection, so it cannot safely straddle a `BEGIN`/`COMMIT` across calls (a
  pool may route each call to a different backend). Every compound operation is
  therefore expressed as a **single data-modifying CTE statement**, which
  Postgres runs once and to completion:
  - *create-org-with-owner* inserts the organization and its owner membership in
    one statement, so an org is **never ownerless** (invariant 3);
  - *add-member* checks org-existence and the unique `(org, user)` conflict in
    one statement, distinguishing `not_found` / `already_member` / success
    without sniffing driver error codes (invariant 4);
  - *remove/demote* read the owner count and act in one statement, refusing to
    drop the **last owner** (invariant 7).

- **Roles are a fixed, ordered set** (`owner > admin > member`), checked in
  process with a rank table — no per-check network. A `CHECK` constraint in the
  migration makes any other value unstorable; `requireMembership({ role })`
  treats `role` as the minimum required.

- **Server-assigned organization ids.** `id` is a `randomUUID()` minted by the
  part, not caller-settable, so two orgs can never collide on a caller-chosen id
  and ids are unguessable handles safe to put in URLs.

- **Constant SQL, fully parameterized.** Every statement is a fixed string with
  positional placeholders; no input is ever concatenated. Injection is
  structurally impossible (invariant 10), and every statement targets only the
  two part-owned tables.

- **Typed errors, raw driver errors contained.** Executor failures wrap as
  `TenancyError("storage")` with a generic message; the raw error (possibly
  carrying credentials or row data) is attached as `cause`, never placed in
  `message`.

- **Conformance runs against real Postgres.** The organization, membership,
  role, last-owner, cascade, and injection invariants run against a real database
  (gated on `PARTKIT_TEST_DATABASE_URL`) using the part's own shipped migration —
  never a mock of our own code (docs/02 §4). The input-validation, typed-error,
  and own-tables/no-cross-part-FK invariants also run DB-free, so the suite still
  attests a non-zero result where no database is available.

## Invariant → conformance test mapping

| # | Invariant (contract.json) | Test (conformance/tenancy.test.ts) |
|---|---|---|
| 1 | No import I/O; typed errors incl. wrapped+redacted storage errors | "invariant 1: a storage failure surfaces as a typed TenancyError…" |
| 2 | Invalid input → `invalid_input`, zero SQL | "invariant 2: invalid input fails fast…" |
| 3 | createOrganization atomic, seeds owner, never ownerless | "invariant 3: createOrganization is atomic and seeds the owner…" |
| 4 | Membership unique per (org,user); duplicate/unknown-org typed | "invariant 4: membership is unique per (org,user)…" |
| 5 | requireMembership gate; non-member→forbidden; enumeration-safe | "invariant 5: requireMembership is the row-level-scoping gate…" |
| 6 | Role hierarchy owner>admin>member in requireMembership({role}) | "invariant 6: requireMembership enforces the role hierarchy…" |
| 7 | Last owner cannot be removed or demoted | "invariant 7: the last owner cannot be removed or demoted" |
| 8 | Scoped reads never cross the tenant boundary | "invariant 8: scoped reads never cross the tenant boundary" |
| 9 | deleteOrganization cascades memberships | "invariant 9: deleteOrganization cascades its memberships" |
| 10 | Own auth_tenant_* only; principal by opaque id (no FK); parameterized (injection) | "invariant 10: every statement…" + "…the migration references the principal but never owns or foreign-keys it" + "…round-trip literally (injection)" + "…statements still touch only auth_tenant_*" |

Invariants 1, 2, and the structural side of 10 run DB-free; 3–9 and 10's
injection/real-DB side run against real Postgres.

## Threat model

- **Cross-tenant data exposure — the headline threat.** The whole value of
  tenancy is that org A can never read org B's rows. `requireMembership` is the
  single chokepoint: it returns a scope only to a verified member, and it is the
  documented precondition for any org-scoped query (`seams.md` §3). The scoped
  reads this part owns (`organizationsForUser`, `listMembers`) are themselves
  filtered to one principal / one org and conformance asserts they never widen.
  Residual: the part cannot enforce the app's own `WHERE org_id = $1` — that
  filter lives in app code by necessity. The mitigation is to make the gate
  unavoidable (you need its return value to get the org id) and to document the
  pattern with a wired example, not to pretend the part can write the app's SQL.

- **Account/organization enumeration.** `requireMembership` returns `forbidden`
  identically whether the organization is missing or the caller simply is not a
  member, so it cannot be used as an existence oracle.

- **Privilege escalation / the last-owner lockout.** Roles are a fixed ordered
  set checked server-side; a client cannot assert a role it was not granted.
  An organization can never be left without an owner: removing or demoting the
  last owner fails with `last_owner`. **Concurrency residual:** the last-owner
  guard is a single statement, which closes the common sequential mistake (an
  admin UI demoting the only owner). Two *simultaneous* demotions of two distinct
  owners can still race under `READ COMMITTED`, because the owner-count subquery
  does not lock the other owner's row. A full guarantee needs `SERIALIZABLE`
  isolation or a single-owner uniqueness constraint; the `SqlExecutor` seam
  cannot mandate an isolation level, so v1 documents this rather than silently
  implying a guarantee it cannot keep. The roadmap carries the hardening.

- **SQL injection.** Every value is a bound parameter in a constant statement;
  the injection conformance case stores `'); DROP TABLE auth_tenant_membership;
  --` as a literal org name and user id and asserts both tables still exist.

- **Cross-part coupling.** No foreign key crosses into `auth.session`'s tables;
  the principal is an opaque value. A conformance test reads the shipped
  migration and fails if any `REFERENCES` targets a non-`auth_tenant_*` table.

- **Credential / data disclosure through errors.** Raw executor errors are never
  put in `TenancyError.message`; only a generic string surfaces, with the cause
  attached for deliberate, scrubbed logging.

- **Tampering via direct table access.** Anyone with DML rights on the
  `auth_tenant_*` tables can bypass the rules above — that is the same trust
  level as editing part interiors and is out of scope here. The boundary
  (lockfile hash + guard) is what keeps app code on the interface.

## Roadmap

- `1.1` (minor, additive): organization rename; an optional unique `slug`
  handle (its own migration + uniqueness rule); a `count`-of-members read.
- Pending **invitations**: a token-based invite flow that composes on
  `email.transactional` (send) and lands a member on accept — additive, a new
  part-owned `auth_tenant_invitation` table.
- Custom roles / permissions beyond the fixed three — needs a small spec note on
  how a fixed-rank model extends without breaking the `requireMembership({ role })`
  contract.
- Last-owner hardening under concurrency: a deferred uniqueness or
  `SERIALIZABLE`-documented path once the seam can express isolation intent.
- When a second provider appears, the conformance suite and capability move to
  the namespace (docs/02 §3-4); the real-Postgres fixture goes with them.
