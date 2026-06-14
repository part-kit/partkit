-- flags.feature @ 1.0.0 — migration 001
-- Part-owned table (docs/02 §6): prefixed `feature_flags`, so it never collides
-- with app tables and the boundary is visible in the DB. Transactional. Flags are
-- mutable by design — NO append-only triggers (unlike audit.log).

CREATE TABLE feature_flags (
  key         text         PRIMARY KEY CHECK (length(key) > 0),
  type        text         NOT NULL CHECK (type IN ('boolean', 'number', 'string', 'json')),
  enabled     boolean      NOT NULL DEFAULT false,
  -- `default` is a SQL reserved word → quoted everywhere. The value when the flag
  -- is ON but no rule/rollout decides.
  "default"   jsonb        NOT NULL,
  rules       jsonb        NOT NULL DEFAULT '[]'::jsonb,   -- first-match-wins targeting
  rollout     jsonb        NOT NULL DEFAULT '[]'::jsonb,   -- sticky percentage variants
  archived_at timestamptz,                                 -- NULL = active; set = soft-disabled
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

-- evaluateAll / listFlags scan active flags; the partial index skips archived rows.
CREATE INDEX feature_flags_active_idx ON feature_flags (key) WHERE archived_at IS NULL;
