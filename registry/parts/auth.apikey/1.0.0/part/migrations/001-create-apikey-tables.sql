-- auth.apikey @ 1.0.0 — migration 001
-- Part-owned table (docs/02 §6): everything here is prefixed `auth_apikey_`, so
-- it never collides with app tables and the boundary is visible in the DB.
-- Transactional (no -- partkit:no-transaction directive): the whole migration
-- commits or rolls back as one unit.

CREATE TABLE auth_apikey_keys (
  -- The public, non-secret leading segment of the key ("ak" + base62). It is
  -- BOTH the verify-time lookup key and the management id returned to the app.
  prefix       text         PRIMARY KEY,
  -- One-way digest of the secret portion: HMAC-SHA256(key = salt, msg = secret).
  -- The plaintext key is never stored and cannot be recovered (invariant 2).
  key_hash     bytea        NOT NULL,
  salt         bytea        NOT NULL,
  -- The principal the key acts as (a user/org id from the app). Opaque here.
  owner_id     text         NOT NULL,
  name         text,                                   -- human label (optional)
  scopes       text[]       NOT NULL DEFAULT '{}',     -- capability strings (all-of at verify)
  created_at   timestamptz  NOT NULL DEFAULT now(),
  last_used_at timestamptz,                            -- throttled last-seen (null = never used)
  expires_at   timestamptz,                            -- null = non-expiring
  revoked_at   timestamptz,                            -- set once revoked (immediate)
  -- Rotation: when a key is rotated, the OLD row records rotated_at and a
  -- bounded grace_until; the old key stays valid only until grace_until passes.
  rotated_at   timestamptz,
  grace_until  timestamptz
);

-- Verify hot path is a single lookup by owner's keys; the PK already indexes
-- prefix. listKeys scans by owner.
CREATE INDEX auth_apikey_keys_owner_idx ON auth_apikey_keys (owner_id);
