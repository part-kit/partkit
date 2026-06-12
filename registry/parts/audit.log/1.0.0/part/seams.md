# Seams — audit.log

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` (attested
interior; edits void the attestation and fail CI).

## 1. No env, no adapter — a connection seam + one migration

This part reads **no env vars** and ships **no registry adapters**. It owns one
Postgres table, `audit_events`, and reaches it through a connection you hand
in. Import:

```jsonc
// tsconfig.json → compilerOptions (recommended alias)
"paths": { "@parts/*": ["./parts/*/src"] }
```

```ts
import { auditLog, AuditError } from "@parts/audit.log";
```

Never deep-import `src/internal/**` (lint-enforced).

## 2. The connection seam (`SqlExecutor`)

The part is **driver-free**: it never imports `pg`. You give it the minimal
executor it needs — the same shape `partkit migrate` uses:

```ts
interface SqlExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
```

Wrap your existing `pg` Pool once (copy `examples/pg-executor.ts`):

```ts
const db: SqlExecutor = {
  query: (sql, params) => pool.query(sql, params ? [...params] : undefined),
};
const log = auditLog(db);
```

Because you pass the executor, you control the connection and transaction:
hand in a pooled client mid-transaction to record the event **in the same
transaction** as the business write it describes — the event lands only if
that write commits.

## 3. Run the migration before first use

`partkit add audit.log` vendors `parts/audit.log/migrations/001-create-audit-events.sql`
but does not run it. Apply it with:

```sh
partkit migrate            # reads DATABASE_URL; records the _part_migrations ledger
```

This creates `audit_events` and the append-only triggers. The table is
**interior** — the boundary in the repo mirrors a boundary in the database:

- Write events only through `log.append(...)`. Do not `INSERT` into
  `audit_events` directly.
- Read events only through `log.query(...)`. Do not `SELECT` from
  `audit_events` directly — that table is the part's, and its shape can change
  across versions; the interface is the contract.
- Never write a migration that touches `audit_events` from your app's chain.

## 4. Append and query

```ts
const event = await log.append({
  actor: userId,            // who (optional; null = system/anonymous)
  action: "billing.charge", // what (required, non-empty)
  target: "invoice:42",     // the object (optional)
  metadata: { amount: 4200, currency: "usd" }, // arbitrary jsonb
});
// event.id (string), event.occurredAt (Date, SERVER time)

const trail = await log.query({
  actor: userId,            // exact-match filters (all optional)
  action: "billing.charge",
  since: new Date(Date.now() - 7 * 864e5),
  limit: 100,               // 1..1000, default 100
  before: cursor,           // pass a prior event.id to page to older events
});                         // newest-first by id
```

`occurred_at` is **server-assigned and not settable** — a trustworthy timeline
is the point of an audit log. If you need a separate "business" time, put it in
`metadata`.

## 5. Error handling

Every failure is an `AuditError` with `.code`:

- `invalid_event` — blank action, an over-long field, or metadata over 64 KB.
- `invalid_query` — limit outside 1..1000, or a malformed `before` cursor.
- `storage` — the executor (database) failed. The raw driver error is on
  `.cause` (which may contain credentials — don't log it blindly); `.message`
  is generic and safe to surface.

## 6. What you must NOT do

- Edit or import anything under `src/internal/**`.
- `INSERT`/`SELECT`/`UPDATE`/`DELETE` against `audit_events` directly — use
  `append`/`query`. (UPDATE/DELETE/TRUNCATE are refused by the database anyway:
  the log is append-only.)
- Pass a timestamp expecting it to become `occurred_at` — it won't.
- Log an `AuditError.cause` without scrubbing it.
