-- auth.session @ 1.0.0 — migration 001
-- Part-owned tables (docs/02 §6), auth_-prefixed via Better Auth's modelName
-- mapping. This SQL is generated from Better Auth's own schema generator
-- (better-auth/db/migration getMigrations().compileMigrations()) for the exact
-- v1 config, so the columns match what the vendored Better Auth reads/writes
-- byte-for-byte. Column identifiers are QUOTED camelCase on purpose — Better
-- Auth's Kysely queries reference them case-sensitively. Do NOT run Better
-- Auth's own migrator; partkit migrate owns the ledger (docs/02 §6).
-- Transactional (no -- partkit:no-transaction directive).

CREATE TABLE "auth_user" (
  "id"            text NOT NULL PRIMARY KEY,
  "name"          text NOT NULL,
  "email"         text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image"         text,
  "createdAt"     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "auth_session" (
  "id"        text NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token"     text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId"    text NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE
);

CREATE TABLE "auth_account" (
  "id"                    text NOT NULL PRIMARY KEY,
  "accountId"             text NOT NULL,
  "providerId"            text NOT NULL,
  "userId"                text NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope"                 text,
  "password"              text,
  "createdAt"             timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             timestamptz NOT NULL
);

CREATE TABLE "auth_verification" (
  "id"         text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value"      text NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "auth_session_userId_idx" ON "auth_session" ("userId");
CREATE INDEX "auth_account_userId_idx" ON "auth_account" ("userId");
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" ("identifier");
