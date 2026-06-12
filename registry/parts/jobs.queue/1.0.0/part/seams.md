# Seams — jobs.queue (also provides jobs.cron)

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` (attested interior;
edits void the attestation and fail CI).

This part gives you **durable background jobs** (retry/backoff/dead-letter) and
**recurring scheduled jobs** (cron) over Postgres — no Redis, no SQS. It wraps
graphile-worker. You provide the database connection and the job handlers.

## 1. Environment

**None declared by the part.** You supply the database connection in code: a
`SqlExecutor` (your `pg` Pool) for enqueue/reads, and a `connectionString` for
the worker (read it from your own `DATABASE_URL` — the part does not mandate a
var name). `partkit add` scaffolds no `.env.example` entries.

Import with a tsconfig alias (recommended):

```jsonc
// tsconfig.json → compilerOptions
"paths": { "@parts/*": ["./parts/*/src"] }
```

```ts
import { jobs, runWorker, drainOnce, JobsError } from "@parts/jobs.queue";
```

Never deep-import `src/internal/**` (lint-enforced).

## 2. npm dependency

This part declares `graphile-worker` in `npm_dependencies`; `partkit add` merges
it into your `package.json`. Install it (`npm install`). It is loaded **lazily**
— importing the part for enqueue-only code does not pull graphile-worker (or its
`pg` driver) into a serverless bundle; only `runWorker`/`drainOnce` load it.

## 3. Run the migration before first use (and before the worker)

`partkit add jobs.queue` vendors
`parts/jobs.queue/migrations/001-install-graphile-worker.sql`. Apply it first:

```sh
partkit migrate     # installs the part-owned graphile_worker schema
```

**Do NOT run graphile-worker's own migrator / `graphile-worker --once`'s
auto-migration as your install step, and do NOT run `graphile-worker` CLI
migrations.** The schema is part-owned and installed by `partkit migrate` (which
records the `_part_migrations` ledger). The vendored migration is generated from
graphile-worker's own schema generator at the pinned version; the worker
re-checks migrations on boot and finds them applied (a no-op). Run `partkit
migrate` before the worker boots, or the worker will try to install the schema
itself and `partkit migrate` will then conflict.

## 4. Enqueue a job (the enqueue seam) — serverless-safe, transactional

Wire your `pg` Pool to the `SqlExecutor` (`examples/pg-executor.ts`, outside the
boundary), then:

```ts
import { jobs } from "@parts/jobs.queue";
const { id } = await jobs(db).enqueue({
  task: "send_welcome_email",            // must match a handler (§5)
  payload: { userId: "u_123" },
  maxAttempts: 5,                        // optional; jobKey, runAt, priority, queueName too
});
```

`enqueue` issues one statement through the seam, so it runs **inside whatever
transaction your executor carries** — enqueue a job in the same transaction as
the business write that triggers it, and the two commit or roll back together.
Pass a `jobKey` for **idempotency**: enqueuing twice with the same key yields one
job. `enqueue` performs no I/O at import and is safe on serverless.

## 5. Write the job handlers (the composition seam)

The part runs your handlers; it does not own your job logic. A handler is
`(payload) => Promise<void>`; throwing triggers a retry. Keep handlers in app
code (e.g. `src/jobs/`) — start from `examples/tasks.ts`:

```ts
const tasks = {
  send_welcome_email: async (payload) => { /* your logic; cast payload */ },
  rebuild_search_index: async () => { /* … */ },
};
```

The `task` you enqueue (§4) must be a key in this map, or no worker will run it.

## 6. Process jobs — two shapes (pick by deploy target)

The contract ships **both** shapes behind one task map (docs/05 §1):

- **Long-running worker (servers / containers)** — a dedicated process:
  ```ts
  const worker = await runWorker({ connectionString, tasks, concurrency: 5 });
  // worker.stop() for graceful shutdown; await worker.done
  ```
  Start it from `examples/worker-entrypoint.ts` (`node dist/worker.js`).

- **Serverless drain (Lambda / Vercel / Cloud Run)** — one pass per invocation,
  triggered by your platform's cron:
  ```ts
  await drainOnce({ connectionString, tasks });   // processes all due jobs, then returns
  ```
  Mount it on a cron-invoked route from `examples/serverless-drain.ts`. Protect
  that route (a shared secret / platform-internal trigger) — draining is not
  public.

Both apply graphile-worker's capped exponential backoff: a failed job is retried
up to `maxAttempts`, each retry scheduled further out. `drainOnce` only runs jobs
that are **due** (a backed-off retry runs on a later pass once its time arrives).

## 7. Recurring jobs (jobs.cron@1)

Add a `cron` schedule to the worker config:

```ts
await runWorker({
  connectionString, tasks,
  cron: [
    { task: "send_daily_digest", pattern: "0 8 * * *" },          // 08:00 daily
    { task: "rebuild_search_index", pattern: "*/15 * * * *", backfillSeconds: 3600 },
  ],
});
```

`pattern` is standard cron (`m h dom mon dow`). `backfillSeconds` re-enqueues
runs missed while the worker was down (within that window) on startup. The cron
**scheduler runs in the long-running worker**. On **serverless**, a long-running
scheduler does not exist — use your platform's cron to invoke the drain route
(§6) on the schedule you want; that is the serverless cron (docs/05 §1).

## 8. The dead-letter (failed jobs)

A job that exhausts `maxAttempts` stops retrying and becomes a dead-letter. List
them for an ops view or to requeue:

```ts
const failed = await jobs(db).listFailed({ task: "send_welcome_email", limit: 50 });
// each: { id, task, payload, attempts, maxAttempts, lastError, runAt, createdAt, queueName }
```

## 9. Error handling

Every failure is a `JobsError` with `.code`: `invalid_input` (bad enqueue/config
input), `storage` (the SqlExecutor seam failed), `worker` (the worker engine
failed — connection, runtime). Retries already happen inside the worker; a
caught `storage` on enqueue means the enqueue itself failed (e.g. DB down).

## 10. Composition — webhooks.dispatch builds on this

`webhooks.dispatch` (Wave 2) uses this part as its delivery engine: it enqueues a
delivery job per outbound webhook and a handler performs the HTTP POST with this
part's retry/backoff/dead-letter. If you wire that yourself, the handler is just
another entry in your task map (§5).

## 11. What you must NOT do

- Edit or import anything under `src/internal/**`.
- `SELECT`/write the `graphile_worker.*` tables directly, or add a migration that
  touches them — the schema is interior; jobs enter via `enqueue`, failures exit
  via `listFailed`. (graphile-worker's own `add_job`/views are the part's
  interior, reached only through this interface.)
- Run graphile-worker's CLI/auto migrator as your install step (§3).
- Log the `connectionString` or full worker errors (use `JobsError.cause` for
  scrubbed logging).
