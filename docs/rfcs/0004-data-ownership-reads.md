# RFC 0004 — `data_ownership.reads`: a declared read surface for admin tooling

**Status:** accepted 2026-06-12 (authorized by Rado to unblock `admin.crud`; chief-architect session)
**Extends:** the `data_ownership` contract field (additive; no `contract_version` bump — the field is optional and older parsers ignore it)
**Unblocks:** `admin.crud` (#10) — the `backoffice` skeleton's distinctive part
**Author:** chief-architect session, 2026-06-12

## 1. Problem

`admin.crud` is "schema-driven internal admin for part-owned tables" — a generic
back office over whatever parts a repo has installed (`audit_events`,
`auth_tenant_*`, `billing_*`, …). That collides with two PartKit invariants:

1. **The import boundary** (docs/02 §7): app code imports only `parts/<name>/src/index`.
   A generic admin cannot import each part's internals to learn its schema.
2. **Data ownership** (`data_ownership.writes_only_own_tables`): only the owning
   part writes its tables, and a part's *invariants live in its mutators*
   (audit.log's append-only triggers, auth.tenancy's last-owner guard). A generic
   admin issuing raw `UPDATE`/`DELETE` would bypass exactly the guarantees the
   attestation makes.

And a third, subtler trap: a part's raw table layout is an **interior**, not a
contract. If `admin.crud` read columns by live schema introspection it would
couple to interiors that can change between versions — the thing the boundary
exists to prevent.

The fix is to make the *readable shape* a small, versioned **contract surface**,
and to keep all writes flowing through the part's public mutators.

## 2. Design

The same triangle: **the contract declares, the tool consumes the declaration,
invariants stay where they are enforced.**

### 2a. Contract declares a read surface

`data_ownership` gains an optional `reads` map (table → descriptor):

```jsonc
"data_ownership": {
  "tables": ["auth_tenant_organization", "auth_tenant_membership"],
  "writes_only_own_tables": true,
  "reads": {
    "auth_tenant_organization": {
      "label": "Organizations",
      "primary_key": "id",
      "order_by": "created_at desc",
      "columns": [
        { "name": "id",         "type": "uuid" },
        { "name": "name",       "type": "string", "label": "Name" },
        { "name": "created_at", "type": "timestamp" }
      ],
      "mutations": { "update": "renameOrganization", "delete": "deleteOrganization" }
    },
    "auth_tenant_membership": {
      "label": "Memberships",
      "primary_key": ["organization_id", "user_id"],
      "columns": [
        { "name": "organization_id", "type": "uuid", "references_capability": "auth.tenancy" },
        { "name": "user_id",         "type": "uuid", "references_capability": "auth.session" },
        { "name": "role",            "type": "string" }
      ]
      // no "mutations" ⇒ read-only in the admin
    }
  }
}
```

- `columns` is the **only** legal projection: admin tooling may `SELECT` exactly
  these columns from exactly these tables — nothing else. A column carrying
  secret/PII data is marked `"redact": true` and is **never** selected or
  returned (not masked client-side — never read).
- `type` is a logical rendering hint (`string`/`number`/`boolean`/`timestamp`/
  `uuid`/`json`), not the SQL type.
- `references_capability` marks an opaque cross-part id (the `auth.tenancy`
  pattern: a `user_id` with no FK) so the admin can offer a link, not a join.
- `mutations` maps an action to a **public export** of the same part
  (from `interface.exports`). Absent ⇒ the table is read-only in the admin.

### 2b. The read boundary

Admin tooling MAY issue read-only `SELECT`s against a table listed in `reads`,
projecting only its declared, non-redacted columns, through the app-provided
`SqlExecutor` seam. It MUST NOT read undeclared tables or columns, and MUST NOT
read a part that declares no `reads`. Because the projection is the contract
(not live introspection), the read is stable within the part's major version.

### 2c. The write boundary (non-negotiable)

Admin tooling MUST NOT issue `INSERT`/`UPDATE`/`DELETE` against another part's
tables — ever. A write goes through the export named in `mutations`, which runs
the part's own validated, invariant-preserving code path. This is what keeps
admin edits honest: deleting the last owner still fails through
`deleteOrganization`, the audit trail is still unrewritable, because the admin
calls the same function the app does. A table with no `mutations` is read-only.

### 2d. `admin.crud` the part

`admin.crud` is schema-driven and adds **no `requires` on the parts it
administers** — it discovers them at runtime from the installed parts' contracts
(`data_ownership.reads`) and renders list/detail/search (2b) plus edit/delete
where `mutations` exist (2c). It `requires: ["auth.session>=1"]` for staff
authentication and should compose with `audit.log` to record admin actions
(documented seam). It owns no domain tables of its own beyond optional admin
metadata.

## 3. Rules (each maps to ≥1 conformance test when `admin.crud` is built)

1. Admin reads project only declared, non-redacted columns of tables in `reads`; a redacted or undeclared column is never returned.
2. A read against a part that declares no `reads` returns nothing — no silent raw-table fallback.
3. Admin writes occur only via the `mutations` exports; the harness proves a raw write path does not exist (e.g. deleting the last org owner still fails with the part's typed error, append-only tables reject admin edits).
4. `admin.crud` carries no compile-time dependency on any administered part — it operates purely off contracts + the `SqlExecutor` seam.

## 4. Compatibility & rollout

- **Additive, no `contract_version` bump.** `reads` is optional; a parser
  without it strips the key (non-strict) and simply renders no admin for that
  part — fail-safe.
- **Published versions are immutable.** Existing parts (audit.log, auth.tenancy,
  …) gain `reads` only in a *future* version (`reads` is hashed content). Until
  then `admin.crud` shows whatever declares it; coverage grows as parts adopt it.
  The `admin.crud` build should bump one or two parts to add `reads` so the
  acme demo's back office has real tables to show.
- The contract schema (`packages/core/src/contract.ts`) gains the optional
  `reads` shape as the enabling platform change for this RFC.

## 5. Roadmap (not v1)

- Filtered/saved views and column-level role gating (which staff role sees which columns).
- A `create` form generated from `mutations.create` argument shapes.
- Read pagination/search hints in the descriptor (cursor column, searchable columns).
