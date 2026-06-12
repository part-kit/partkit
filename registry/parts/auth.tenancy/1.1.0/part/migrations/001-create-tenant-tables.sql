-- auth.tenancy @ 1.0.0 — migration 001
-- Part-owned tables (docs/02 §6): everything here is prefixed `auth_tenant_`,
-- so it never collides with app tables and the boundary is visible in the DB.
-- Transactional (no -- partkit:no-transaction directive): the whole migration
-- commits or rolls back as one unit.
--
-- BOUNDARY NOTE: this part references auth.session's principal but does NOT
-- duplicate or foreign-key it. `user_id` is an opaque text value supplied by the
-- app (it comes from getSession at the seam, docs seams.md §4). There is
-- deliberately NO `REFERENCES auth_user (...)` here: a foreign key into another
-- part's table would couple two part interiors and break the cross-part boundary
-- (docs/02 §6 — part migrations touch only their own tables). The FK below stays
-- WITHIN this part (membership → organization).

CREATE TABLE auth_tenant_organization (
  -- App-visible, URL-safe handle. Server-assigned by the part (randomUUID), not
  -- caller-settable, so two orgs can never collide on a caller-chosen id.
  id          text        NOT NULL PRIMARY KEY,
  name        text        NOT NULL CHECK (length(name) > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_tenant_membership (
  organization_id text        NOT NULL REFERENCES auth_tenant_organization (id) ON DELETE CASCADE,
  -- The principal, by reference. Opaque text (an auth.session user id); NO FK to
  -- auth_user — see the boundary note above.
  user_id         text        NOT NULL CHECK (length(user_id) > 0),
  role            text        NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- One membership per (organization, user). The composite primary key makes a
  -- duplicate membership structurally impossible — addMember relies on it.
  PRIMARY KEY (organization_id, user_id)
);

-- "Which organizations does this user belong to" — the row-level-scoping read.
-- The composite PK already serves "members of this organization" (leading column).
CREATE INDEX auth_tenant_membership_user_idx ON auth_tenant_membership (user_id);

-- Fast "is there still an owner" check for the last-owner guard on
-- removeMember / setRole (a partial index over just the owner rows).
CREATE INDEX auth_tenant_membership_owner_idx
  ON auth_tenant_membership (organization_id)
  WHERE role = 'owner';
