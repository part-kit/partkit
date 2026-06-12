# audit.log — SPEC

Append-only domain event log over a part-owned Postgres table, written and
queried through a contract-stable interface and a driver-free `SqlExecutor`
seam. v1 scope is **append + query** with database-enforced immutability.

## Design decisions

- **The connection is a seam, not env or a driver.** The part imports no `pg`
  and reads no `DATABASE_URL`; the app hands in the same minimal `SqlExecutor`
  shape `partkit migrate` uses. So this part ships **zero adapters and zero
  env** (like `ratelimit.api`), and — crucially — it runs on the app's
  connection and transaction. An event can be appended in the same transaction
  as the business write it records, so the two commit or roll back together.
- **First DB-backed part.** It owns `audit_events` (`data_ownership`), ships
  `migrations/001-create-audit-events.sql`, and is applied by `partkit migrate`
  into the `_part_migrations` ledger (docs/02 §6). The table is interior: the
  repo boundary is mirrored in the database — app code never reads or writes
  `audit_events` directly, data exits through `query`.
- **Append-only is enforced by the database, not just the interface.**
  Withholding a mutator from the API stops honest callers; a `BEFORE UPDATE OR
  DELETE` row trigger and a `BEFORE TRUNCATE` statement trigger stop everyone
  short of someone with DDL rights on the part's own table (which is a boundary
  violation by other means). The trail cannot be quietly rewritten.
- **`occurred_at` is server-assigned and not caller-settable.** A trustworthy
  order of events is the defining property of an audit log; letting callers
  backdate entries would defeat it. Business timestamps go in `metadata`.
- **Monotonic id as the cursor.** `bigint GENERATED ALWAYS AS IDENTITY` gives a
  total insertion order even when `occurred_at` values tie, so newest-first
  ordering and `before`-cursor pagination are deterministic. The id is
  serialized to a string at the boundary to avoid JS number precision loss.
- **Constant SQL, fully parameterized.** Both statements are fixed strings with
  positional placeholders and NULL-guarded filters (`$1::text IS NULL OR actor
  = $1`), so no input is ever concatenated into SQL and one statement serves
  every filter combination. Injection is structurally impossible (invariant 5).
- **Typed errors, raw driver errors contained.** Executor failures wrap as
  `AuditError("storage")` with a generic message; the raw error (possibly
  carrying credentials or row data) is attached as `cause`, never placed in
  `message`.
- **Conformance runs against real Postgres.** The persistence, append-only,
  query, and injection invariants run against a real database (gated on
  `PARTKIT_TEST_DATABASE_URL`) using the part's own shipped migration — never a
  mock of our own code (docs/02 §4). The input-validation and typed-error
  invariants also run DB-free, so the suite still attests a non-zero result
  where no database is available (e.g. CI without a Postgres service).

## Invariant → conformance test mapping

| # | Invariant (contract.json) | Test (conformance/audit.test.ts) |
|---|---|---|
| 1 | No import I/O; typed errors incl. wrapped storage errors | "invariant 1: a storage failure surfaces as a typed AuditError…" |
| 2 | append persists, assigns id/occurred_at, reads back | "invariant 2: append persists one row…" |
| 3 | DB rejects UPDATE/DELETE/TRUNCATE (append-only) | "invariant 3: the database rejects UPDATE, DELETE, and TRUNCATE…" |
| 4 | newest-first, filters, bounded limit + cursor | "invariant 4: query is newest-first by id…" |
| 5 | faithful round-trip, parameterized (injection) | "invariant 5: SQL metacharacters round-trip literally…" |
| 6 | invalid event/query → typed error, zero SQL | "invariant 6: an invalid event…" + "invariant 6: an invalid query…" |
| 7 | driver-free seam; statements touch only audit_events | "invariant 7: every statement…" (DB-free) + "invariant 7: against the real database…" |

Invariants 1, 6, and the SQL-shape side of 7 run DB-free; 2–5 and 7's
persistence side run against real Postgres.

## Threat model

- **Tampering with the trail.** The whole value of an audit log is that it
  cannot be edited after the fact. UPDATE, DELETE, and TRUNCATE on
  `audit_events` are refused by database triggers, so neither a bug nor a
  compromised app path can rewrite history through normal DML. Residual: an
  actor with DDL privileges on the part's own table can disable the triggers —
  that is the same trust level as editing part interiors, out of scope here,
  and a candidate for the future append-only-via-permissions hardening.
- **SQL injection.** Every value is a bound parameter in a constant statement;
  the injection conformance case stores `'); DROP TABLE audit_events; --` as
  literal data and asserts the table still exists.
- **Credential / data disclosure through errors.** Raw executor errors are
  never put in `AuditError.message`; only a generic string surfaces, with the
  cause attached for deliberate, scrubbed logging.
- **PII and retention.** The part stores exactly what the app appends — actor,
  action, target, and arbitrary `metadata`. It imposes no retention or
  redaction policy in v1; callers must avoid putting secrets in `metadata` and
  own their own retention. A redaction/retention story is a roadmap item.
- **Unbounded reads.** `query` caps at 1000 rows and rejects larger limits, so
  a single call cannot scan the table unboundedly; pagination is via the
  `before` cursor.
- **Forged timestamps.** `occurred_at` is `DEFAULT now()` and not writable
  through the interface, so the timeline reflects server time, not caller input.

## Roadmap

- `1.1` (minor, additive): a `count`/aggregation read and a `target`-prefix
  filter for "everything that happened to object X"; both additive to `query`.
- Retention & redaction: a part-owned, migration-driven retention policy
  (e.g. partition-by-month drop) and a metadata field-redaction helper —
  needs a data-policy spec note first.
- Append-only via revoked privileges (in addition to triggers) once the part
  can declare a least-privilege role in its migration story.
- When a second provider appears, the conformance suite and capability move to
  the namespace (docs/02 §3-4); the real-Postgres fixture goes with them.
