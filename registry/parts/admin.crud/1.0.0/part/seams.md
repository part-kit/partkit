# Seams — admin.crud

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` (attested interior;
edits void the attestation and fail CI).

admin.crud is a **schema-driven back office** over your OTHER installed parts. It
reads each part's declared `data_ownership.reads` (RFC 0004) and renders
list/detail/edit — projecting only declared, non-redacted columns and routing
every write through that part's own mutators. It imports nothing from the parts
it administers; you wire it with data.

## 1. Environment

**None.** admin.crud declares no env. It `requires: ["auth.session>=1"]` only so
your repo has **staff authentication** — YOU gate the admin routes with
`requireSession` (§6); admin.crud does not authenticate.

```ts
import { admin, collectReads, AdminError } from "@parts/admin.crud";
```

Never deep-import `src/internal/**` (lint-enforced).

## 2. Discover what's administrable (the reads seam)

admin.crud administers exactly the tables your installed parts declare in
`data_ownership.reads`. Load those contracts and extract them with `collectReads`
(pure, no I/O — you supply the contracts):

```ts
// app side: read your installed parts' contract.json (build-time or cached)
const contracts = await loadInstalledContracts(); // [{ part, data_ownership? }, ...]
const resources = collectReads(contracts);        // only parts that declare reads
```

A part that declares no `reads` contributes nothing — there is no raw-table
fallback. See `examples/load-resources.ts`.

## 3. Wire the read connection (the SqlExecutor seam)

Reads go through the same minimal `SqlExecutor` the other DB parts use; wire your
`pg` Pool (`examples/pg-executor.ts`):

```ts
const a = admin({ resources, db: pgExecutor(pool), mutators });
const rows = await a.list("auth_tenant_organization", { limit: 50 });
const one  = await a.get("auth_tenant_organization", { id });
```

`list`/`get` SELECT **only the declared, non-redacted columns** — a `redact:true`
column is never fetched. Constructing `admin()` performs no I/O.

## 4. Wire the writes (the mutator seam) — never raw SQL

admin.crud **never issues a write**. A `create`/`update`/`delete` in a table's
`mutations` map names a **public export** of the owning part; YOU import that
export and wire it, so the write runs the part's own validated, invariant-
preserving code path:

```ts
import { tenancy } from "@parts/auth.tenancy"; // the owning part
const mutators = {
  "auth.tenancy": {
    // names match the `mutations` values in auth.tenancy's reads
    deleteOrganization: ({ key }) => tenancy(pgExecutor(pool)).deleteOrganization(String(key!.id)),
  },
};
await a.remove("auth_tenant_organization", { id });   // → calls deleteOrganization
```

A table with no `mutations` is **read-only** (`AdminError("read_only")`). A
mutation declared but not wired throws `AdminError("no_mutator")`. The mutator's
own typed errors **propagate unchanged** — deleting the last org owner still
fails with the part's `last_owner` error; an append-only audit table still
rejects edits. The admin cannot bypass an invariant, because it calls the same
function your app does.

## 5. Render the UI from `resources()`

`a.resources()` returns the metadata to drive a generic UI — per resource:
`part`, `table`, `label`, `primaryKey`, `columns` (name/type/label/
`referencesCapability`, redacted ones already removed), and `actions`
(`{create,update,delete}` — which mutations exist). `references_capability` marks
an opaque cross-part id: render a link, not a join.

## 6. Composition — staff auth + audit (the two composition seams)

- **auth.session (required):** gate every admin route. Resolve the staff session
  with `requireSession(headers)` and authorize before calling admin.crud — it
  trusts that you have. See `examples/admin-routes.ts`.
- **audit.log (recommended):** record each admin write. Wrap your mutator wiring
  to `auditLog(db).append({ actor: staff.id, action: "admin.delete", target })`
  so privileged actions land in the trail. Documented and shown in the example.

## 7. What you must NOT do

- Edit or import anything under `src/internal/**`.
- Read undeclared tables/columns, or `SELECT`/write a part's tables directly to
  "shortcut" the admin — that re-creates the boundary and ownership violations
  RFC 0004 exists to prevent. Add `reads`/`mutations` to the part instead.
- Hand admin.crud a `db` whose role can write part tables and assume that makes
  writes safe — admin.crud still never writes; routes go through mutators.

## 8. Make your OWN parts administrable

If you author parts, add `data_ownership.reads` (RFC 0004): per table, the
`columns` admin may read (`redact:true` for secrets/PII), a `primary_key`,
optional `order_by`, and a `mutations` map pointing at your public exports. Then
they appear in any admin.crud back office automatically — no admin code changes.

## 9. Not in v1

Generated create forms (from `mutations.create` argument shapes), filtered/saved
views and search, and column-level role gating (which staff role sees which
columns) are roadmap (RFC 0004 §5).
