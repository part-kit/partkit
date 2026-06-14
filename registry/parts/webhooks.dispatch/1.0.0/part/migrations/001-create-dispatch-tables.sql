-- webhooks.dispatch @ 1.0.0 — migration 001
-- Part-owned tables (docs/02 §6): everything is prefixed `webhooks_dispatch_`,
-- so it never collides with app tables and the boundary is visible in the DB.
-- Transactional (no -- partkit:no-transaction directive): commits or rolls back
-- as one unit.

-- Registered customer destinations. The `secret` is stored because outbound
-- Standard Webhooks signing is symmetric (HMAC) — we must hold it to sign each
-- delivery. It is returned to the owner ONCE at registration and never exposed
-- again (contract invariant 7). Protect this table like any credential store.
CREATE TABLE webhooks_dispatch_endpoints (
  id          text         PRIMARY KEY,                 -- ep_…
  owner_id    text         NOT NULL,                    -- the app's principal (opaque)
  url         text         NOT NULL,                    -- https, public-address-only (invariant 6)
  secret      text         NOT NULL,                    -- whsec_<base64> signing secret
  event_types text[],                                   -- null = all event types
  created_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_dispatch_endpoints_owner_idx ON webhooks_dispatch_endpoints (owner_id);

-- The transactional outbox: one row per dispatched event, carrying its own
-- retry state (status, attempt_count, next_attempt_at) so deliverDue is a
-- self-contained drainer and the part owns retry/backoff/dead-letter without a
-- hard dependency on jobs.queue (RFC 0003 §4).
CREATE TABLE webhooks_dispatch_outbox (
  id              text         PRIMARY KEY,             -- msg_… (also the Standard Webhooks webhook-id)
  endpoint_id     text         NOT NULL REFERENCES webhooks_dispatch_endpoints (id),
  event_type      text         NOT NULL,
  payload         text         NOT NULL,                -- the exact JSON bytes we sign + send
  idempotency_key text,                                 -- null = no dedupe; non-null is unique per endpoint
  status          text         NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'delivered', 'dead')),
  attempt_count   integer      NOT NULL DEFAULT 0,
  next_attempt_at timestamptz  NOT NULL DEFAULT now(),
  created_at      timestamptz  NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  -- At-least-once idempotency (invariant 5): the same key enqueued twice yields
  -- ONE row. A NULL key never conflicts (Postgres treats NULLs as distinct), so
  -- callers who don't pass a key always enqueue a fresh row.
  UNIQUE (endpoint_id, idempotency_key)
);
-- The deliverDue hot path: pending rows whose backoff has elapsed, oldest first.
CREATE INDEX webhooks_dispatch_outbox_due_idx
  ON webhooks_dispatch_outbox (next_attempt_at)
  WHERE status = 'pending';

-- The delivery log: every attempt — outcome, status, latency, next-retry —
-- recorded, never silently dropped (invariant 4). No secret or resolved IP here.
CREATE TABLE webhooks_dispatch_attempts (
  id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id      text         NOT NULL REFERENCES webhooks_dispatch_outbox (id),
  attempt_no      integer      NOT NULL,
  attempted_at    timestamptz  NOT NULL DEFAULT now(),
  status_code     integer,                              -- null = network error / blocked
  outcome         text         NOT NULL
                               CHECK (outcome IN ('delivered', 'retrying', 'dead')),
  latency_ms      integer,
  next_attempt_at timestamptz,                          -- when the next retry is scheduled (null = terminal)
  error           text                                  -- generic cause; never a secret or internal IP
);
CREATE INDEX webhooks_dispatch_attempts_msg_idx
  ON webhooks_dispatch_attempts (message_id, attempt_no);
