/**
 * Conformance suite for capability webhooks.dispatch@1.
 *
 * Each test names the contract invariant it makes true — the invariant list in
 * contract.json and this file must stay 1:1. This part has no registry adapters
 * (the database connection is an app seam), so the publish script runs once.
 *
 * Two blocks:
 *  - DB-free (always on): invariants 1, 7, the no-DB facets of 2/8, the signing
 *    known-answer vector (3), and SSRF URL-rejection (6) — typed errors,
 *    fail-fast validation, own-table SQL — exercised with a recording executor.
 *  - Real Postgres (gated on PARTKIT_TEST_DATABASE_URL): outbox/delivery/retry/
 *    backoff/dead-letter/idempotency against a real database + a protocol-faithful
 *    fake receiver, driving deliverDue({now}) with a fake clock (docs/02 §4).
 */
import { request as httpRequest } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispatcher, DispatchError, type SqlExecutor } from "../src/index";
import { deliver, isPublicAddress } from "../src/internal/ssrf";
import { signStandardWebhooks } from "../src/internal/sign";
import { bad400, fail500, FakeReceiver, ok, rate429 } from "./fake-receiver";
import { cannedEndpointRow, RecordingExecutor } from "./recording-executor";

const TABLE_RE = /\b(from|into|update|join|table)\s+"?([a-z_][a-z0-9_.]*)"?/gi;
function assertOwnTableOnly(statements: { sql: string }[]): void {
  expect(statements.length).toBeGreaterThan(0);
  for (const { sql } of statements) {
    for (const m of sql.matchAll(TABLE_RE)) {
      expect(m[2]).toMatch(/^webhooks_dispatch_/);
    }
  }
}

/** Raw POST to the fake receiver (for the tamper test). */
function postRaw(url: string, body: Buffer, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: { ...headers, "content-length": String(body.length) },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// ── DB-free: typed errors, validation, signing vector, SSRF rejection, own-table ──
describe("conformance: webhooks.dispatch@1 · DB-free (no database required)", () => {
  beforeAll(() => {
    delete process.env["WEBHOOKS_SSRF_ALLOW"]; // SSRF guard must be ACTIVE here
  });

  it("invariant 1: a storage failure surfaces as a typed DispatchError, raw error redacted", async () => {
    const rec = new RecordingExecutor();
    rec.failWith = new Error("FATAL: password authentication failed for user 'secret'");
    const wh = dispatcher(rec);
    const err = await wh
      .dispatch({ endpointId: "ep_x", eventType: "e", payload: { a: 1 } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as DispatchError).code).toBe("storage");
    expect((err as DispatchError).message).not.toContain("password authentication failed");
    expect((err as DispatchError).cause).toBeInstanceOf(Error);
  });

  it("invariant 1: invalid input fails fast with a typed error and issues zero SQL", async () => {
    const rec = new RecordingExecutor();
    const wh = dispatcher(rec);
    await expect(wh.registerEndpoint({ ownerId: "", url: "https://x.test" })).rejects.toMatchObject({
      code: "invalid_payload",
    });
    await expect(wh.dispatch({ endpointId: "", eventType: "e", payload: {} })).rejects.toMatchObject({
      code: "invalid_payload",
    });
    // a non-JSON-serializable payload (BigInt) fails before any SQL
    await expect(
      wh.dispatch({ endpointId: "ep_x", eventType: "e", payload: BigInt(1) }),
    ).rejects.toMatchObject({ code: "invalid_payload" });
    await expect(wh.deliverDue({ batch: 0 })).rejects.toMatchObject({ code: "invalid_payload" });
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 3: the signer matches the Standard Webhooks canonical test vector (byte-identical)", () => {
    // The spec's own published vector — what webhooks.ingest's standardwebhooks
    // adapter verifies. A wire-format drift cannot pass this.
    const signed = signStandardWebhooks({
      id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      payload: Buffer.from('{"test": 2432232314}', "utf8"),
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      timestampSeconds: 1614265330,
    });
    expect(signed["webhook-signature"]).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
    expect(signed["webhook-id"]).toBe("msg_p5jXN8AQM9LWM0D4loKWxJek");
    expect(signed["webhook-timestamp"]).toBe("1614265330");
  });

  it("invariant 6: SSRF — isPublicAddress refuses non-public IPs, accepts public ones", async () => {
    for (const blocked of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254 (metadata) on a NAT64 host
      "64:ff9b::7f00:1", // NAT64 of 127.0.0.1
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await isPublicAddress(blocked)).toBe(false);
    }
    for (const pub of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await isPublicAddress(pub)).toBe(true);
    }
  });

  it("invariant 6: registerEndpoint refuses http and non-public destinations, with zero SQL", async () => {
    const rec = new RecordingExecutor();
    const wh = dispatcher(rec);
    for (const url of [
      "http://example.test/hook", // not https
      "https://127.0.0.1/hook", // loopback
      "https://169.254.169.254/latest/meta-data", // cloud metadata
      "https://10.0.0.1/hook", // RFC-1918
      "https://[::1]/hook", // IPv6 loopback
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(wh.registerEndpoint({ ownerId: "o", url })).rejects.toMatchObject({
        code: "invalid_url",
      });
    }
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 6: the blockList refuses a private IP at delivery (fresh socket, agent:false)", async () => {
    delete process.env["WEBHOOKS_SSRF_ALLOW"]; // 10.0.0.1 not allowlisted → real gate applies
    // https + a blocked literal IP → ERR_IP_BLOCKED before connect → kind "blocked".
    const result = await deliver(
      "https://10.0.0.1/hook",
      Buffer.from("{}", "utf8"),
      { "content-type": "application/json" },
      { timeoutMs: 1000 },
    );
    expect(result.kind).toBe("blocked");
  });

  it("invariant 2/DoS: deliver enforces an absolute deadline — a slow-trickle endpoint cannot hang", async () => {
    // A raw TCP server that starts an HTTP response but trickles bytes forever
    // without completing the header block — defeats the socket inactivity timeout.
    const trickle = createTcpServer((socket) => {
      socket.write("HTTP/1.1 2");
      const iv = setInterval(() => {
        try {
          socket.write("0");
        } catch {
          /* socket gone */
        }
      }, 40);
      socket.on("close", () => clearInterval(iv));
      socket.on("error", () => clearInterval(iv));
    });
    await new Promise<void>((r) => trickle.listen(0, "127.0.0.1", r));
    const port = (trickle.address() as AddressInfo).port;
    const saved = process.env["WEBHOOKS_SSRF_ALLOW"];
    process.env["WEBHOOKS_SSRF_ALLOW"] = "127.0.0.1"; // reach the loopback test server
    try {
      const started = Date.now();
      const result = await deliver(
        `http://127.0.0.1:${port}/`,
        Buffer.from("{}", "utf8"),
        { "content-type": "application/json" },
        { timeoutMs: 300 },
      );
      expect(result.kind).toBe("network"); // bounded by the absolute deadline, not hung
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      if (saved === undefined) delete process.env["WEBHOOKS_SSRF_ALLOW"];
      else process.env["WEBHOOKS_SSRF_ALLOW"] = saved;
      await new Promise<void>((r) => trickle.close(() => r()));
    }
  });

  it("invariant 7: no secret material appears in error messages", async () => {
    const rec = new RecordingExecutor();
    rec.failWith = new Error("boom");
    const wh = dispatcher(rec);
    // register against a public literal IP so it reaches the (failing) INSERT.
    const err = await wh
      .registerEndpoint({ ownerId: "o", url: "https://8.8.8.8/hook" })
      .catch((e: unknown) => e);
    expect((err as DispatchError).code).toBe("storage");
    expect((err as DispatchError).message).not.toMatch(/whsec_/);
  });

  it("invariant 8: every statement the part issues targets only webhooks_dispatch_* tables", async () => {
    const rec = new RecordingExecutor();
    rec.rows = [cannedEndpointRow()];
    const wh = dispatcher(rec);
    await wh.registerEndpoint({ ownerId: "o", url: "https://8.8.8.8/hook" }); // INSERT endpoint
    await wh.dispatch({ endpointId: "ep_canned", eventType: "e", payload: { a: 1 } }); // SELECT + INSERT outbox
    rec.rows = []; // make the next deliverDue find nothing due (no HTTP)
    await wh.deliverDue({ now: new Date(), batch: 10 }); // SELECT due
    await wh.listAttempts("msg_x"); // SELECT attempts
    assertOwnTableOnly(rec.calls);
  });
});

// ── Real Postgres + fake receiver: outbox, delivery, retry, dead-letter, idem ──
const PG_URL = process.env["PARTKIT_TEST_DATABASE_URL"];

interface RecordingPg extends SqlExecutor {
  statements: string[];
}

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "conformance: webhooks.dispatch@1 · real Postgres + fake receiver",
  () => {
    const schema = `dispatch_conf_${process.pid}`;
    let client: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      end: () => Promise<void>;
    };
    let db: RecordingPg;
    let recv: FakeReceiver;
    let secret = "";
    let seq = 0;
    const owner = (): string => `owner_${process.pid}_${(seq += 1)}`;

    // A fake clock for backoff windows. Anchored just AFTER real now in
    // beforeEach so it is >= the outbox's next_attempt_at (which defaults to DB
    // now() at dispatch); advance() then moves it forward deterministically.
    let fakeNow = new Date();
    const advance = (seconds: number): void => {
      fakeNow = new Date(fakeNow.getTime() + seconds * 1000);
    };

    beforeAll(async () => {
      process.env["NODE_ENV"] = "test";
      // TEST-ONLY override so deliveries reach the in-process loopback receiver.
      process.env["WEBHOOKS_SSRF_ALLOW"] = "127.0.0.1,::1";

      const pg = (await import("pg")).default;
      const c = new pg.Client({ connectionString: PG_URL });
      await c.connect();
      client = c as unknown as typeof client;
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET search_path TO ${schema}`);
      const migration = await readFile(
        new URL("../migrations/001-create-dispatch-tables.sql", import.meta.url),
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

      recv = new FakeReceiver("placeholder"); // secret set per registered endpoint below
      await recv.start();
    });

    afterAll(async () => {
      if (recv !== undefined) await recv.stop();
      if (client !== undefined) {
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await client.end();
      }
      delete process.env["WEBHOOKS_SSRF_ALLOW"];
    });

    beforeEach(() => {
      if (db !== undefined) db.statements.length = 0;
      recv.received.length = 0;
      recv.script.length = 0;
      fakeNow = new Date(Date.now() + 60_000); // just past real now → freshly-dispatched rows are due
    });

    /** Register an endpoint pointing at the fake receiver and align its secret. */
    async function endpointToReceiver(): Promise<string> {
      const reg = await dispatcher(db).registerEndpoint({ ownerId: owner(), url: recv.url() });
      secret = reg.secret;
      (recv as unknown as { secret: string }).secret = reg.secret; // receiver verifies with the real secret
      return reg.id;
    }

    it("invariant 2: dispatch persists to the outbox and returns WITHOUT delivering inline", async () => {
      const endpointId = await endpointToReceiver();
      const { messageId } = await dispatcher(db).dispatch({
        endpointId,
        eventType: "invoice.paid",
        payload: { n: 1 },
      });
      expect(messageId).toMatch(/^msg_/);
      expect(recv.received).toHaveLength(0); // no HTTP happened during dispatch

      recv.script.push(ok);
      const report = await dispatcher(db).deliverDue({ now: fakeNow });
      expect(report.delivered).toBe(1);
      expect(recv.received).toHaveLength(1); // delivery only in deliverDue
    });

    it("invariant 3: a real delivery carries a signature the receiver verifies; a tampered body fails", async () => {
      const endpointId = await endpointToReceiver();
      await dispatcher(db).dispatch({ endpointId, eventType: "e", payload: { ok: true } });
      recv.script.push(ok);
      await dispatcher(db).deliverDue({ now: fakeNow });
      expect(recv.received[0]!.verified).toBe(true);

      // Tamper: sign payload A but send payload B → receiver rejects.
      const headers = signStandardWebhooks({
        id: "msg_tamper",
        payload: Buffer.from(JSON.stringify({ a: 1 }), "utf8"),
        secret,
        timestampSeconds: Math.floor(Date.now() / 1000),
      });
      await postRaw(recv.url(), Buffer.from(JSON.stringify({ a: 2 }), "utf8"), {
        ...headers,
        "content-type": "application/json",
      });
      expect(recv.received.at(-1)!.verified).toBe(false);
    });

    it("invariant 4: a 5xx is retried with backoff, recorded, then succeeds", async () => {
      const endpointId = await endpointToReceiver();
      const { messageId } = await dispatcher(db).dispatch({ endpointId, eventType: "e", payload: {} });

      recv.script.push(fail500);
      let rep = await dispatcher(db).deliverDue({ now: fakeNow });
      expect(rep.delivered).toBe(0);
      expect(rep.retried).toBe(1);

      // still inside the backoff window → not due → no second attempt
      rep = await dispatcher(db).deliverDue({ now: fakeNow });
      expect(rep.attempted).toBe(0);

      // advance past the backoff window → due → succeed
      advance(120);
      recv.script.push(ok);
      rep = await dispatcher(db).deliverDue({ now: fakeNow });
      expect(rep.delivered).toBe(1);

      const attempts = await dispatcher(db).listAttempts(messageId);
      expect(attempts.map((a) => a.statusCode)).toEqual([500, 200]);
      expect(attempts.map((a) => a.outcome)).toEqual(["retrying", "delivered"]);
      expect(attempts[0]!.nextAttemptAt).toBeInstanceOf(Date);
    });

    it("invariant 4: a 429 Retry-After overrides the computed backoff", async () => {
      const endpointId = await endpointToReceiver();
      const { messageId } = await dispatcher(db).dispatch({ endpointId, eventType: "e", payload: {} });
      recv.script.push(rate429(300));
      await dispatcher(db).deliverDue({ now: fakeNow });
      const attempts = await dispatcher(db).listAttempts(messageId);
      expect(attempts[0]!.statusCode).toBe(429);
      expect(attempts[0]!.outcome).toBe("retrying");
      // 300s from Retry-After, not the 60s computed backoff
      expect(attempts[0]!.nextAttemptAt!.getTime()).toBe(fakeNow.getTime() + 300_000);
    });

    it("invariant 4: a permanent 4xx is not retried; exhausted retries dead-letter", async () => {
      // permanent 4xx
      const ep1 = await endpointToReceiver();
      const m1 = await dispatcher(db).dispatch({ endpointId: ep1, eventType: "e", payload: {} });
      recv.script.push(bad400);
      let rep = await dispatcher(db).deliverDue({ now: fakeNow });
      expect(rep.dead).toBe(1);
      rep = await dispatcher(db).deliverDue({ now: fakeNow });
      expect(rep.attempted).toBe(0); // not retried
      let attempts = await dispatcher(db).listAttempts(m1.messageId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.outcome).toBe("dead");

      // exhaust retries → dead-letter (MAX_ATTEMPTS = 6)
      const ep2 = await endpointToReceiver();
      const m2 = await dispatcher(db).dispatch({ endpointId: ep2, eventType: "e", payload: {} });
      for (let i = 0; i < 6; i += 1) {
        recv.script.push(fail500);
        // eslint-disable-next-line no-await-in-loop
        rep = await dispatcher(db).deliverDue({ now: fakeNow });
        advance(3600); // past any backoff window
      }
      attempts = await dispatcher(db).listAttempts(m2.messageId);
      expect(attempts).toHaveLength(6);
      expect(attempts.at(-1)!.outcome).toBe("dead");
      // a dead message is never retried again
      rep = await dispatcher(db).deliverDue({ now: fakeNow });
      expect(rep.attempted).toBe(0);
    });

    it("invariant 5: the same idempotencyKey yields exactly one outbox row", async () => {
      const endpointId = await endpointToReceiver();
      const a = await dispatcher(db).dispatch({
        endpointId,
        eventType: "e",
        payload: { v: 1 },
        idempotencyKey: "evt-123",
      });
      const b = await dispatcher(db).dispatch({
        endpointId,
        eventType: "e",
        payload: { v: 2 },
        idempotencyKey: "evt-123",
      });
      expect(b.messageId).toBe(a.messageId);
      const count = await client.query(
        `SELECT count(*)::int AS n FROM webhooks_dispatch_outbox WHERE idempotency_key = $1`,
        ["evt-123"],
      );
      expect(count.rows[0]!["n"]).toBe(1);
    });

    it("invariant 6: delivery to a non-public destination is refused at delivery time", async () => {
      const endpointId = await endpointToReceiver(); // registered while override is ON
      const { messageId } = await dispatcher(db).dispatch({ endpointId, eventType: "e", payload: {} });
      const saved = process.env["WEBHOOKS_SSRF_ALLOW"];
      delete process.env["WEBHOOKS_SSRF_ALLOW"]; // override OFF — loopback now refused
      try {
        const before = recv.received.length;
        await dispatcher(db).deliverDue({ now: fakeNow });
        expect(recv.received.length).toBe(before); // nothing delivered
        const attempts = await dispatcher(db).listAttempts(messageId);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]!.statusCode).toBeNull(); // no HTTP response — refused before connect
        expect(attempts[0]!.error).not.toBeNull();
      } finally {
        process.env["WEBHOOKS_SSRF_ALLOW"] = saved;
      }
    });

    it("invariant 8: SQL metacharacters round-trip literally; statements touch only own tables", async () => {
      const evil = "o'); DROP TABLE webhooks_dispatch_outbox; --";
      const reg = await dispatcher(db).registerEndpoint({ ownerId: evil, url: recv.url() });
      (recv as unknown as { secret: string }).secret = reg.secret;
      const { messageId } = await dispatcher(db).dispatch({
        endpointId: reg.id,
        eventType: evil,
        payload: { note: evil },
      });
      recv.script.push(ok);
      await dispatcher(db).deliverDue({ now: fakeNow });
      const attempts = await dispatcher(db).listAttempts(messageId);
      expect(attempts).toHaveLength(1);
      // the tables still exist — the injection string was data, not SQL
      const exists = await client.query("SELECT to_regclass('webhooks_dispatch_outbox') AS t");
      expect(exists.rows[0]!["t"]).not.toBeNull();
      assertOwnTableOnly(db.statements.map((sql) => ({ sql })));
    });
  },
);
