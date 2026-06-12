# Seam changes — auth.tenancy 1.0.0 → 1.1.0

**No application seam changes.** This is a purely additive minor — `partkit
upgrade auth.tenancy` re-vendors the contract and needs no code or database
change.

What changed: the contract gains `data_ownership.reads` (RFC 0004), declaring the
read surface `admin.crud` renders for the part-owned tables:

- **Organizations** (`auth_tenant_organization`) — list `id`, `name`,
  `created_at`; `delete` routes to the `deleteOrganization` export.
- **Memberships** (`auth_tenant_membership`) — list `organization_id`,
  `user_id`, `role`, `created_at`; `update` routes to `setRole`, `delete` to
  `removeMember`. `user_id` is marked an opaque cross-part id
  (`references_capability: auth.session`) — the admin links, it does not join.

No secret/PII columns are exposed. The interface, the `auth_tenant_*` schema, and
migration `001` are unchanged.

To surface these tables in an `admin.crud` back office, wire the mutator exports
named above (see admin.crud `seams.md` §4). Nothing in your existing wiring needs
to change otherwise.
