/**
 * Conformance suite for capability auth.tenancy@1.
 *
 * Each test names the contract invariant it makes true — the invariant list in
 * contract.json and this file must stay 1:1. This part has no registry adapters
 * (the database connection is an app seam), so the publish script runs the
 * suite once.
 *
 * Two blocks:
 *  - DB-free (always on): invariants 1, 2, and the structural side of 10 —
 *    typed errors, fail-fast validation, own-tables-only SQL, and the
 *    no-cross-part-foreign-key migration check, exercised with a recording
 *    executor and by reading the shipped migration.
 *  - Real Postgres (gated on PARTKIT_TEST_DATABASE_URL): invariants 3–9 and
 *    10's injection side — the meaningful ones (atomic create-with-owner,
 *    membership uniqueness, the authorization gate, the role hierarchy,
 *    last-owner protection, tenant-scoped reads, cascade), run against a real
 *    database, never a mock (docs/02 §4). The part's own shipped migration
 *    creates the tables.
 */
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenancy, TenancyError, type Membership, type SqlExecutor } from "../src/index";
import { RecordingExecutor } from "./recording-executor";

const PART_TABLES = new Set(["auth_tenant_organization", "auth_tenant_membership"]);
const TABLE_RE = /\b(from|into|update|join|table)\s+"?([a-z_][a-z0-9_.]*)"?/gi;
const CTE_RE = /(?:\bwith\b|,)\s+([a-z_][a-z0-9_]*)\s+as\s*\(/gi;

/** Every table a statement names must be a part-owned table or a CTE it defines. */
function assertOwnTablesOnly(sql: string): void {
  const ctes = new Set<string>();
  for (const m of sql.matchAll(CTE_RE)) ctes.add(m[1]!.toLowerCase());
  for (const m of sql.matchAll(TABLE_RE)) {
    const table = m[2]!.toLowerCase();
    expect(PART_TABLES.has(table) || ctes.has(table)).toBe(true);
  }
}

// ── DB-free: typed errors, fail-fast validation, own-table SQL, no cross-part FK
describe("conformance: auth.tenancy@1 · DB-free (no database required)", () => {
  it("invariant 1: a storage failure surfaces as a typed TenancyError, raw error redacted", async () => {
    const rec = new RecordingExecutor();
    rec.failWith = new Error("FATAL: password authentication failed for user 'secret'");
    const tnc = tenancy(rec);
    const err = await tnc
      .createOrganization({ name: "Acme", ownerUserId: "user_1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenancyError);
    expect((err as TenancyError).code).toBe("storage");
    expect((err as TenancyError).message).not.toContain("password authentication failed");
  });

  it("invariant 2: invalid input fails fast with a typed error and issues zero SQL", async () => {
    const rec = new RecordingExecutor();
    const tnc = tenancy(rec);
    // blank organization name
    await expect(
      tnc.createOrganization({ name: "  ", ownerUserId: "u1" }),
    ).rejects.toMatchObject({ name: "TenancyError", code: "invalid_input" });
    // empty user id
    await expect(
      tnc.createOrganization({ name: "Acme", ownerUserId: "" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // unknown role
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tnc.addMember({ organizationId: "o1", userId: "u1", role: "superuser" as any }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // empty organization id on a read
    await expect(tnc.getOrganization("")).rejects.toMatchObject({ code: "invalid_input" });
    // over-long id
    await expect(tnc.organizationsForUser("x".repeat(1000))).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 10: every statement the part issues targets only auth_tenant_* tables", async () => {
    const rec = new RecordingExecutor();
    const tnc = tenancy(rec);
    const ref = { organizationId: "o1", userId: "u1" };
    // Exercise every distinct statement; canned rows are empty so interpretation
    // may throw — caught — but the SQL is recorded either way.
    await tnc.createOrganization({ name: "Acme", ownerUserId: "u1" }).catch(() => {});
    await tnc.getOrganization("o1").catch(() => {});
    await tnc.deleteOrganization("o1").catch(() => {});
    await tnc.addMember({ ...ref, role: "member" }).catch(() => {});
    await tnc.setRole({ ...ref, role: "admin" }).catch(() => {});
    await tnc.removeMember(ref).catch(() => {});
    await tnc.getMembership(ref).catch(() => {});
    await tnc.requireMembership({ ...ref, role: "admin" }).catch(() => {});
    await tnc.listMembers("o1").catch(() => {});
    await tnc.organizationsForUser("u1").catch(() => {});

    expect(rec.calls.length).toBe(10);
    for (const { sql } of rec.calls) assertOwnTablesOnly(sql);
  });

  it("invariant 10: the migration references the principal but never owns or foreign-keys it", async () => {
    const raw = await readFile(
      new URL("../migrations/001-create-tenant-tables.sql", import.meta.url),
      "utf8",
    );
    // Strip line comments — the prose deliberately names auth_user to explain
    // the boundary; only the DDL is under test.
    const ddl = raw.replace(/--[^\n]*/g, "");
    // No foreign key (or any reference) into auth.session's tables.
    expect(ddl).not.toMatch(/references\s+"?auth_user/i);
    for (const m of ddl.matchAll(/references\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
      expect(m[1]!.toLowerCase().startsWith("auth_tenant_")).toBe(true);
    }
    // Every table created is part-owned (auth_tenant_*).
    const created = [...ddl.matchAll(/create\s+table\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((m) =>
      m[1]!.toLowerCase(),
    );
    expect(created.length).toBeGreaterThan(0);
    for (const t of created) expect(t.startsWith("auth_tenant_")).toBe(true);
  });
});

// ── Real Postgres: organizations, memberships, roles, last-owner, cascade ────
const PG_URL = process.env["PARTKIT_TEST_DATABASE_URL"];

interface RecordingPg extends SqlExecutor {
  statements: string[];
}

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "conformance: auth.tenancy@1 · real Postgres",
  () => {
    const schema = `auth_tenant_conf_${process.pid}`;
    let client: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      end: () => Promise<void>;
    };
    let db: RecordingPg;
    let seq = 0;
    /** Fresh, unique principal/name per use so tests don't collide in one schema. */
    const uid = (label: string): string => `${label}_${process.pid}_${(seq += 1)}`;

    beforeAll(async () => {
      const pg = (await import("pg")).default;
      const c = new pg.Client({ connectionString: PG_URL });
      await c.connect();
      client = c;
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET search_path TO ${schema}`);
      // Run the part's ACTUAL shipped migration — conformance covers the SQL the
      // consumer will run, not a hand-rolled table.
      const migration = await readFile(
        new URL("../migrations/001-create-tenant-tables.sql", import.meta.url),
        "utf8",
      );
      await c.query(migration);

      const statements: string[] = [];
      db = {
        statements,
        query: async (sql, params) => {
          statements.push(sql);
          const r = await c.query(sql, params === undefined ? undefined : [...params]);
          return { rows: r.rows as Record<string, unknown>[] };
        },
      };
    });

    afterAll(async () => {
      if (client !== undefined) {
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await client.end();
      }
    });

    beforeEach(() => {
      if (db !== undefined) db.statements.length = 0;
    });

    it("invariant 3: createOrganization is atomic and seeds the owner; org is never ownerless", async () => {
      const owner = uid("owner");
      const tnc = tenancy(db);
      const org = await tnc.createOrganization({ name: "Acme Inc", ownerUserId: owner });
      expect(org.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(org.name).toBe("Acme Inc");

      // Immediately readable, and the creator is the owner.
      expect((await tnc.getOrganization(org.id))?.id).toBe(org.id);
      const m = await tnc.getMembership({ organizationId: org.id, userId: owner });
      expect(m?.role).toBe("owner");
      const members = await tnc.listMembers(org.id);
      expect(members).toHaveLength(1);
      expect(members[0]!.userId).toBe(owner);
    });

    it("invariant 4: membership is unique per (org,user); duplicate and unknown-org are typed", async () => {
      const owner = uid("owner");
      const bob = uid("bob");
      const tnc = tenancy(db);
      const org = await tnc.createOrganization({ name: "Uniq", ownerUserId: owner });

      const m = await tnc.addMember({ organizationId: org.id, userId: bob });
      expect(m.role).toBe("member"); // default role

      await expect(tnc.addMember({ organizationId: org.id, userId: bob })).rejects.toMatchObject({
        code: "already_member",
      });
      // exactly one membership for bob — no second row
      const bobRows = (await tnc.listMembers(org.id)).filter((x) => x.userId === bob);
      expect(bobRows).toHaveLength(1);

      await expect(
        tnc.addMember({ organizationId: "does-not-exist", userId: bob }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("invariant 5: requireMembership is the row-level-scoping gate (cross-tenant isolation)", async () => {
      const alice = uid("alice");
      const bob = uid("bob");
      const tnc = tenancy(db);
      const orgA = await tnc.createOrganization({ name: "A", ownerUserId: alice });
      const orgB = await tnc.createOrganization({ name: "B", ownerUserId: bob });

      // alice belongs to A → gets her scope
      const scope = await tnc.requireMembership({ organizationId: orgA.id, userId: alice });
      expect(scope.role).toBe("owner");
      expect(scope.organizationId).toBe(orgA.id);

      // alice does NOT belong to B → forbidden (the cross-tenant gate)
      await expect(
        tnc.requireMembership({ organizationId: orgB.id, userId: alice }),
      ).rejects.toMatchObject({ code: "forbidden" });

      // a missing org is forbidden too, indistinguishable from non-membership
      await expect(
        tnc.requireMembership({ organizationId: "missing-org", userId: alice }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    it("invariant 6: requireMembership enforces the role hierarchy owner > admin > member", async () => {
      const owner = uid("owner");
      const viewer = uid("viewer");
      const manager = uid("manager");
      const tnc = tenancy(db);
      const org = await tnc.createOrganization({ name: "RBAC", ownerUserId: owner });
      await tnc.addMember({ organizationId: org.id, userId: viewer, role: "member" });
      await tnc.addMember({ organizationId: org.id, userId: manager, role: "admin" });

      // member meets 'member' but not 'admin'
      await expect(
        tnc.requireMembership({ organizationId: org.id, userId: viewer, role: "member" }),
      ).resolves.toMatchObject({ role: "member" });
      await expect(
        tnc.requireMembership({ organizationId: org.id, userId: viewer, role: "admin" }),
      ).rejects.toMatchObject({ code: "forbidden" });

      // admin meets 'admin' (and 'member') but not 'owner'
      await expect(
        tnc.requireMembership({ organizationId: org.id, userId: manager, role: "admin" }),
      ).resolves.toMatchObject({ role: "admin" });
      await expect(
        tnc.requireMembership({ organizationId: org.id, userId: manager, role: "owner" }),
      ).rejects.toMatchObject({ code: "forbidden" });

      // owner meets everything
      await expect(
        tnc.requireMembership({ organizationId: org.id, userId: owner, role: "owner" }),
      ).resolves.toMatchObject({ role: "owner" });
    });

    it("invariant 7: the last owner cannot be removed or demoted", async () => {
      const founder = uid("founder");
      const second = uid("second");
      const ghost = uid("ghost");
      const tnc = tenancy(db);
      const org = await tnc.createOrganization({ name: "Owned", ownerUserId: founder });
      await tnc.addMember({ organizationId: org.id, userId: second, role: "member" });

      // sole owner is protected against both removal and demotion
      await expect(
        tnc.removeMember({ organizationId: org.id, userId: founder }),
      ).rejects.toMatchObject({ code: "last_owner" });
      await expect(
        tnc.setRole({ organizationId: org.id, userId: founder, role: "admin" }),
      ).rejects.toMatchObject({ code: "last_owner" });
      // unchanged
      expect((await tnc.getMembership({ organizationId: org.id, userId: founder }))?.role).toBe(
        "owner",
      );

      // promote a second owner, THEN the founder can leave
      await tnc.setRole({ organizationId: org.id, userId: second, role: "owner" });
      await tnc.removeMember({ organizationId: org.id, userId: founder });
      expect(await tnc.getMembership({ organizationId: org.id, userId: founder })).toBeNull();

      // 'second' is now the last owner — protected again
      await expect(
        tnc.removeMember({ organizationId: org.id, userId: second }),
      ).rejects.toMatchObject({ code: "last_owner" });

      // removing a non-member is a typed not_a_member, not a silent no-op
      await expect(
        tnc.removeMember({ organizationId: org.id, userId: ghost }),
      ).rejects.toMatchObject({ code: "not_a_member" });
    });

    it("invariant 8: scoped reads never cross the tenant boundary", async () => {
      const alice = uid("alice");
      const bob = uid("bob");
      const carol = uid("carol");
      const tnc = tenancy(db);
      const orgA = await tnc.createOrganization({ name: "A", ownerUserId: alice });
      const orgB = await tnc.createOrganization({ name: "B", ownerUserId: bob });
      await tnc.addMember({ organizationId: orgA.id, userId: carol, role: "member" });

      // organizationsForUser returns exactly the user's orgs
      expect((await tnc.organizationsForUser(carol)).map((m) => m.organizationId)).toEqual([
        orgA.id,
      ]);
      expect((await tnc.organizationsForUser(alice)).map((m) => m.organizationId)).toEqual([
        orgA.id,
      ]);

      // listMembers returns exactly that org's members
      const aMembers = (await tnc.listMembers(orgA.id)).map((m) => m.userId).sort();
      expect(aMembers).toEqual([alice, carol].sort());
      expect((await tnc.listMembers(orgB.id)).map((m) => m.userId)).toEqual([bob]);
    });

    it("invariant 9: deleteOrganization cascades its memberships", async () => {
      const owner = uid("owner");
      const member = uid("member");
      const tnc = tenancy(db);
      const org = await tnc.createOrganization({ name: "Doomed", ownerUserId: owner });
      await tnc.addMember({ organizationId: org.id, userId: member, role: "member" });
      expect(await tnc.listMembers(org.id)).toHaveLength(2);

      await tnc.deleteOrganization(org.id);
      expect(await tnc.getOrganization(org.id)).toBeNull();
      expect(await tnc.listMembers(org.id)).toHaveLength(0);
      // the member's membership cascaded away
      expect(await tnc.organizationsForUser(member)).toHaveLength(0);
    });

    it("invariant 10: SQL metacharacters round-trip literally and never execute (injection)", async () => {
      const evil = "'); DROP TABLE auth_tenant_membership; --";
      const tnc = tenancy(db);
      const org = await tnc.createOrganization({ name: evil, ownerUserId: evil });

      expect((await tnc.getOrganization(org.id))?.name).toBe(evil);
      const m = await tnc.getMembership({ organizationId: org.id, userId: evil });
      expect(m?.userId).toBe(evil);
      expect(m?.role).toBe("owner");

      // the tables still exist — the injection string was data, not SQL
      const exists = await client.query(
        "SELECT to_regclass('auth_tenant_membership') AS t, to_regclass('auth_tenant_organization') AS o",
      );
      expect(exists.rows[0]!["t"]).not.toBeNull();
      expect(exists.rows[0]!["o"]).not.toBeNull();
    });

    it("invariant 10: against the real database, statements still touch only auth_tenant_*", async () => {
      const owner = uid("owner");
      const member = uid("member");
      const tnc = tenancy(db);
      const org = await tnc.createOrganization({ name: "Shape", ownerUserId: owner });
      await tnc.addMember({ organizationId: org.id, userId: member, role: "member" });
      await tnc.setRole({ organizationId: org.id, userId: member, role: "admin" });
      await tnc.requireMembership({ organizationId: org.id, userId: member, role: "admin" });
      await tnc.organizationsForUser(member);
      const _scope: Membership = await tnc.requireMembership({
        organizationId: org.id,
        userId: owner,
      });
      expect(_scope.role).toBe("owner");

      for (const sql of db.statements) assertOwnTablesOnly(sql);
    });
  },
);
