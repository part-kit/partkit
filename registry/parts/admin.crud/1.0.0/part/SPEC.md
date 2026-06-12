# admin.crud — SPEC

Schema-driven internal admin over OTHER parts' tables, driven entirely by their
declared `data_ownership.reads` (RFC 0004). v1 is list / detail / paginated read
plus edit / delete where the owning part declares mutations — a generic back
office that couples to contracts, never to interiors. The `backoffice`
skeleton's distinctive part.

## Design decisions

- **The problem RFC 0004 solves.** A generic admin over part-owned tables
  collides with two PartKit invariants: the import boundary (a generic admin
  cannot import each part's internals to learn its schema) and data ownership
  (only the owning part writes its tables, and a part's invariants live in its
  mutators). And a subtler trap: a raw table layout is an *interior*, not a
  contract — reading by live introspection would couple to something that changes
  between versions. The fix is a small, versioned **contract surface** for reads
  and **part mutators** for writes.

- **Reads are a declared projection, not introspection.** admin.crud reads only
  the columns a part lists in `data_ownership.reads`, and only the non-redacted
  ones — a `redact:true` column is **never selected or returned** (not masked
  client-side; never read). Because the projection is the contract, the read is
  stable within the part's major version. `references_capability` marks an opaque
  cross-part id (the `auth.tenancy` pattern): the admin offers a link, not a join.

- **Writes route through the part's mutators — there is no raw write path.**
  `create`/`update`/`delete` dispatch to the public export named in `mutations`,
  which the app wires. admin.crud issues **no write SQL at all** (there is no
  write-SQL builder to exploit), so deleting the last org owner still fails
  through `deleteOrganization`, an append-only audit table still rejects edits —
  the invariants stay where they are enforced. A mutator's own typed errors
  propagate **unwrapped**. A table with no mutation is read-only.

- **No dependency on the administered parts.** admin.crud adds no `requires` on
  the parts it manages and imports nothing from them; it adapts at runtime from
  the passed `data_ownership.reads` declarations, the `SqlExecutor` seam, and the
  mutator registry. The conformance suite administers a *fictional* part to prove
  it (contract invariant 6).

- **The connection is the SqlExecutor seam** (reads only) — driver-free,
  serverless-safe, the `audit.log` pattern. admin.crud owns no tables and ships
  no migration; it reads others' tables and dispatches others' writes.

- **Identifiers validated and quoted; values parameterized.** Every identifier
  put into SQL (schema, table, column, `order_by`) is checked against a strict
  `^[a-z_][a-z0-9_]*$` and double-quoted; every value is a bound parameter. A
  malformed reads declaration (a non-identifier column) is rejected with
  `invalid_contract` before any SQL, and a key carrying SQL metacharacters is
  data, never code. `order_by` columns must be declared and non-redacted, so the
  admin never even orders by a column it cannot read.

- **`requires: auth.session>=1` for staff auth; composes with audit.log.** The
  app gates admin routes with `requireSession` (admin.crud does not
  authenticate) and should wrap mutators to record actions to `audit.log` (both
  shown in `examples/admin-routes.ts`).

- **Conformance.** A fixture table + synthetic reads run against real Postgres
  (gated on `PARTKIT_TEST_DATABASE_URL`): a redacted column is never fetched, a
  metacharacter key round-trips as data, and a write flows through a mutator (a
  real delete) rather than admin SQL. The projection shape, unknown-resource,
  the write boundary (zero SQL on writes), and identifier-safety run DB-free.

## Invariant → conformance test mapping

| # | Invariant (contract.json) | Test (conformance/admin.test.ts) |
|---|---|---|
| 1 | No import I/O; typed errors, raw error redacted | "invariant 1: a storage failure surfaces as a typed AdminError…" |
| 2 | Reads project only declared, non-redacted columns | "invariant 2: reads project only declared…" (shape) + "invariant 2: a redacted column's value is never fetched…" (real PG) |
| 3 | Undeclared resource → unknown_resource, zero SQL, no raw fallback | "invariant 3: an undeclared resource fails…" |
| 4 | Writes dispatch to mutators only — never SQL; read-only/missing typed; part errors propagate | "invariant 4: writes dispatch to mutators only…" + "invariant 4: a write flows through the mutator (real delete)…" |
| 5 | Identifiers validated/quoted, values parameterized — no injection | "invariant 5: identifiers are validated/quoted…" + "invariant 5: a key with SQL metacharacters round-trips…" |
| 6 | No compile-time/runtime dep on administered parts | "invariant 6: admin.crud administers a part it has no code for…" |

Invariants 1, 3, 4 (boundary), the shape side of 2, and the identifier side of 5
run DB-free; the data side of 2, the injection round-trip of 5, the real
mutator-write of 4, and 6 against real data run against real Postgres.

## Threat model

- **Sensitive-data exposure through the admin.** The whole risk of a generic
  admin is over-reading. admin.crud reads only declared, non-redacted columns of
  declared tables — a secret/PII column marked `redact:true` is never put in a
  `SELECT`, and a table no part declares is refused (`unknown_resource`). There
  is no raw-table fallback and no live introspection.

- **Bypassing a part's invariants via the admin.** A generic admin issuing raw
  `UPDATE`/`DELETE` would void exactly the guarantees the attestation makes.
  admin.crud has no write-SQL path; every write is the part's own mutator, run
  with the part's validation, so its invariants hold. The conformance suite
  proves a mutator's typed error (e.g. a last-owner guard) reaches the caller
  unchanged and that a read-only table refuses writes with zero SQL.

- **SQL injection via a malformed contract or a crafted key.** Identifiers are
  validated against a strict identifier regex and double-quoted; values are bound
  parameters. A reads declaration with a non-identifier column is rejected before
  any SQL; an id of `'); DROP TABLE … --` is stored/queried as literal data and
  the table survives (conformance asserts both).

- **The admin's database role.** admin.crud reads through whatever `SqlExecutor`
  the app hands it; it never writes. If that role *can* write part tables, that
  is an app-side concern — the route must be staff-gated (auth.session) and only
  the wired mutators should perform writes. admin.crud cannot widen its own
  privileges.

- **Trusting the reads declaration.** The projection comes from the part's
  attested `contract.json`; a tampered contract is caught upstream by the
  lockfile content hash and `partkit verify`. admin.crud additionally validates
  every identifier it reads, so even a malformed-but-hash-valid declaration
  cannot inject — it fails closed with `invalid_contract`.

- **Staff authentication.** admin.crud does not authenticate; it `requires`
  auth.session and trusts the app to gate every route with `requireSession`
  before any admin call. An unauthenticated admin route is an app-side seam
  failure, documented in seams.md §6.

## Roadmap

- Generated **create** forms from `mutations.create` argument shapes (v1 wires
  create through a mutator but ships no form generator).
- Filtered / saved views and search hints in the descriptor (a searchable-columns
  list, a cursor column) for large tables.
- Column-level role gating: which staff role may read which columns (today the
  projection is the same for all staff).
- When a second provider appears, the conformance suite and capability move to
  the namespace (docs/02 §3-4).
