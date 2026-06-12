# jobs.queue — SPEC

Durable background jobs with capped exponential-backoff retries and a
dead-letter (**jobs.queue@1**), plus recurring scheduled jobs (**jobs.cron@1**),
over a part-owned Postgres schema. One part, two capabilities — graphile-worker
provides both. v1 scope is enqueue + the two worker shapes + retry/backoff +
dead-letter read + cron; the job handlers are the app's composition seam.

## Design decisions

- **Wrap graphile-worker; portable by construction.** The queue is
  Postgres-native — no Redis, no SQS, no managed vendor. It runs on the plain
  Node + Postgres a team self-hosts (§1.9 portability). A second queue library
  would be a *second part* providing `jobs.queue@1`, not an adapter axis (the
  `auth.session`/Better Auth precedent), so this part ships **zero adapters** and
  a single `default` attestation. graphile-worker is declared in
  `npm_dependencies` (RFC 0001) and pinned by the attestation at the tested
  version.

- **Two connection tiers, by responsibility.** The *enqueue* and *dead-letter
  read* run through the app-provided `SqlExecutor` seam (the `audit.log`
  pattern): no driver import on that path, serverless-safe, and **transactional**
  — a job can be enqueued in the same transaction as the business write that
  triggers it via graphile-worker's own `add_job` SQL function. The *processing*
  side wraps graphile-worker's worker. graphile-worker is loaded with a **dynamic
  `import()`**, only when a worker shape is called, so importing the part for
  enqueue-only serverless code pulls neither graphile-worker nor its `pg` driver
  into the bundle, and importing the part performs no I/O (invariant 1).

- **Two worker shapes — the honest serverless exception (docs/05 §1).** A queue
  worker is a long-running process by nature, so the part ships both shapes
  behind one task map: `runWorker` (a daemon for servers/containers) and
  `drainOnce` (one drain pass per invocation, for a serverless function on the
  platform's cron). The same `tasks` map and the same retry/backoff engine drive
  both.

- **jobs.cron@1 over the same queue.** A `cron` schedule on the worker config
  maps to graphile-worker's crontab; the scheduler runs inside the daemon shape.
  On serverless, a long-running scheduler does not exist — the platform's cron is
  the trigger (it invokes the drain route), which is the honest serverless cron.
  `backfillSeconds` re-enqueues runs missed while the worker was down.

- **Schema is part-owned and installed by partkit migrate** (the `auth.session`
  pattern). The vendored `migrations/001` is generated from graphile-worker's
  **own** migrator (`runMigrations` against a scratch DB, then `pg_dump
  --inserts`), including the 18 rows of graphile-worker's migration ledger — so
  when the worker re-checks migrations on boot it finds them all applied and does
  **nothing** (a verified no-op, conformance invariant 8). A graphile-worker
  release that bumps the schema is a jobs.queue **minor** that ships a new
  migration. Do not run graphile-worker's migrator separately; `partkit migrate`
  owns the ledger.

- **A dedicated schema, not a table prefix — a stronger boundary.**
  graphile-worker mandates its own Postgres schema (`graphile_worker`). That is a
  deviation from the docs/02 §6 *prefix* convention (`jobs_*`), but a *stronger*
  namespace boundary: every owned object is `graphile_worker.*` and cannot
  collide with app or other-part tables. docs/02 §6 is reconciled in the same
  commit to allow a dedicated schema where a wrapped library requires one.

- **Typed wrapping required a harness fix.** The isolated-conformance harness
  detected graphile-worker as *untyped* (it ships `dist/index.d.ts` via `main`
  with no top-level `types` field) and injected an opaque `declare module` shim
  that shadowed its real types. The fix (this commit) teaches the harness's
  `untypedDeps` to also resolve types adjacent to `main`/`module` — additive, and
  verified not to change any already-detected dependency (better-auth has a
  `types` field). The gate now type-checks the wrapper against graphile-worker's
  real signatures.

- **Constant, fully-parameterized SQL.** Enqueue calls `add_job` and the
  dead-letter read joins the `jobs` view to the backing table — both fixed
  strings with positional placeholders against the `graphile_worker` schema only
  (invariant 8). Payloads and keys with SQL metacharacters are data, never code.

- **Typed errors, raw errors contained.** Seam failures wrap as
  `JobsError("storage")`, worker-engine failures as `JobsError("worker")`, both
  with a generic message; the raw error — which may carry the connection string —
  is attached as `cause`, never placed in `message`.

- **Conformance runs against real graphile-worker + real Postgres** in the
  isolated harness (only the declared graphile-worker installed, `pg` as a
  conformance test dep). Persistence, processing in both shapes, retry/backoff,
  the dead-letter, idempotent enqueue, cron via backfill, the migration no-op,
  and injection run against the real engine (gated on
  `PARTKIT_TEST_DATABASE_URL`); validation, typed-error, invalid-cron, and
  own-schema invariants run DB-free.

## Invariant → conformance test mapping

| # | Invariant (contract.json) | Test (conformance/jobs.test.ts) |
|---|---|---|
| 1 | No import I/O; typed errors with connection-string redaction | "invariant 1: a storage failure surfaces as a typed JobsError…" |
| 2 | Invalid enqueue/config input → invalid_input, no work | "invariant 2: invalid enqueue input…" + "invariant 2: invalid worker config…" |
| 3 | enqueue persists via the seam, serverless-safe, visible to a worker | "invariant 3+4: enqueue persists via the seam…" |
| 4 | A worker runs the handler + removes on success; same map, both shapes | "invariant 3+4: …drainOnce runs the handler…" + "invariant 4: the long-running worker (runWorker)…" |
| 5 | Retry with backoff up to maxAttempts, then dead-letter; listFailed | "invariant 5: a failing job retries with backoff…" |
| 6 | jobKey → single job (idempotent enqueue) | "invariant 6: enqueuing twice with the same jobKey…" |
| 7 | cron runs the recurring task (backfill); invalid pattern → invalid_input | "invariant 7: a cron schedule runs…" + "invariant 7: an invalid cron pattern…" |
| 8 | Part owns graphile_worker schema; worker boot-migrate is a no-op; own-schema parameterized SQL | "invariant 8: …boot-time migration is a no-op…" + "invariant 8: …seam issues SQL against only the graphile_worker schema" + "invariant 8: …migration installs only the graphile_worker schema" + "invariant 8: …metacharacters in a payload round-trip…" |

Invariants 1, 2, the config side of 7, and the own-schema/migration shape of 8
run DB-free; 3–6, the cron side of 7, and 8's no-op + injection run against real
graphile-worker + Postgres.

## Threat model

- **Connection-string disclosure through errors.** The connection string is the
  crown jewel here. Raw seam/engine errors are never placed in
  `JobsError.message`; only a generic string surfaces, the raw error attached as
  `cause` for deliberate, scrubbed logging. The redaction conformance case
  asserts a Postgres auth error carrying `secret`/`password` does not appear in
  the message.

- **Code execution via enqueue.** A worker runs only the tasks present in its
  `tasks` map; a job enqueued for an unknown task is never picked up (no handler
  is invoked), so enqueuing cannot cause arbitrary code to run — the app decides
  what code exists. Enqueue carries data (a JSON payload), not code.

- **SQL injection.** Every value is a bound parameter in a constant statement;
  the injection conformance case enqueues a payload containing `'); DROP TABLE
  graphile_worker._private_jobs; --`, processes it, asserts it round-trips
  literally, and asserts the table still exists.

- **Poison jobs / runaway retries.** Retries are bounded by `maxAttempts` with
  capped exponential backoff; a job that keeps failing dead-letters rather than
  looping forever, and `listFailed` surfaces it for inspection/requeue. Payloads
  are capped (256 KiB serialized) at enqueue.

- **Unauthorized draining.** The serverless drain route processes jobs and must
  not be public — `examples/serverless-drain.ts` requires a shared-secret bearer
  token and documents that the route be reachable only by the platform cron.
  This is an app-side seam obligation (the part cannot mount the route).

- **Schema tampering.** The `graphile_worker` schema is part-owned; anyone with
  direct DML/DDL on it can bypass the queue's guarantees — the same trust level
  as editing part interiors, out of scope here. The boundary (lockfile hash +
  guard + the "do not touch graphile_worker.*" seam rule) keeps app code on the
  interface.

- **Cron backfill amplification.** A large `backfillSeconds` with a frequent
  pattern enqueues many catch-up jobs on startup. It is opt-in per schedule and
  bounded by the configured window; document the window you choose.

## Roadmap

- `1.x` (additive): a `pgPool`/transaction-handle option for the worker (today
  the worker takes a `connectionString`); exposing graphile-worker job *helpers*
  (logger, `withPgClient`, in-handler `addJob`) to handlers; batch enqueue
  (`add_jobs`); requeue/remove helpers over the dead-letter.
- A serverless **cron driver**: a drain variant that also ticks due cron items
  from `_private_known_crontabs`, so jobs.cron needs only a platform cron + one
  route (today serverless cron is platform-cron-per-schedule).
- A configurable schema name (today fixed to `graphile_worker`).
- graphile-worker version tracking: each schema-affecting upgrade ships as a
  jobs.queue minor with a regenerated migration and a re-pinned attestation.
- When a second provider appears, the conformance suite and capabilities move to
  the namespace (docs/02 §3-4); the real-Postgres fixture goes with them.
