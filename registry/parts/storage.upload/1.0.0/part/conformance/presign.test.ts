/**
 * Conformance suite for capability storage.upload@1.
 *
 * Presigning is pure computation, so the suite is fully offline and
 * deterministic. Correctness is anchored to AWS's OWN implementation: the
 * golden vectors in vectors.ts were produced by the AWS CLI (botocore), and
 * the part must reproduce each signed URL byte-for-byte. The PUT/upload path
 * (the CLI presigns GET only) is checked against reference-sigv4.ts, which the
 * same vectors prove correct. Time is pinned with fake timers so X-Amz-Date is
 * deterministic.
 *
 * Each test names the contract invariant it makes true — contract.json and
 * this file stay 1:1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { presignDownload, presignUpload, StorageError } from "../src/index.js";
import { presignReference } from "./reference-sigv4.js";
import {
  ACCESS_KEY_ID,
  amzDateToMs,
  SECRET_ACCESS_KEY,
  VECTORS,
  type KnownAnswer,
} from "./vectors.js";

const ENV_KEYS = [
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_FORCE_PATH_STYLE",
] as const;

function applyConfig(v: Pick<KnownAnswer, "endpoint" | "region" | "bucket" | "forcePathStyle">): void {
  process.env["STORAGE_ENDPOINT"] = v.endpoint;
  process.env["STORAGE_REGION"] = v.region;
  process.env["STORAGE_BUCKET"] = v.bucket;
  process.env["STORAGE_ACCESS_KEY_ID"] = ACCESS_KEY_ID;
  process.env["STORAGE_SECRET_ACCESS_KEY"] = SECRET_ACCESS_KEY;
  process.env["STORAGE_FORCE_PATH_STYLE"] = String(v.forcePathStyle);
}

function sigOf(url: string): string {
  return new URL(url).searchParams.get("X-Amz-Signature") ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("conformance: storage.upload@1", () => {
  describe("invariant 2: signatures match AWS (botocore) byte-for-byte", () => {
    for (const v of VECTORS) {
      it(`download URL is identical to the AWS CLI: ${v.name}`, async () => {
        applyConfig(v);
        vi.setSystemTime(amzDateToMs(v.amzDate));
        const res = await presignDownload(v.key, { expiresInSeconds: v.expiresInSeconds });
        expect(res.method).toBe("GET");
        expect(res.url).toBe(v.url); // exact string — host, path, every param, signature
        // the independent reference matches AWS too, so it is a trustworthy oracle for PUT
        const ref = presignReference({
          method: "GET",
          endpoint: v.endpoint,
          region: v.region,
          bucket: v.bucket,
          key: v.key,
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY,
          forcePathStyle: v.forcePathStyle,
          amzDate: v.amzDate,
          expiresInSeconds: v.expiresInSeconds,
        });
        expect(ref.signature).toBe(v.signature);
      });
    }

    it("upload (PUT) matches the independent reference the vectors proved correct", async () => {
      for (const v of [VECTORS[0]!, VECTORS[3]!]) {
        applyConfig(v);
        vi.setSystemTime(amzDateToMs(v.amzDate));
        const res = await presignUpload(v.key, { expiresInSeconds: v.expiresInSeconds });
        expect(res.method).toBe("PUT");
        const ref = presignReference({
          method: "PUT",
          endpoint: v.endpoint,
          region: v.region,
          bucket: v.bucket,
          key: v.key,
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY,
          forcePathStyle: v.forcePathStyle,
          amzDate: v.amzDate,
          expiresInSeconds: v.expiresInSeconds,
        });
        expect(res.url).toBe(ref.url);
      }
    });
  });

  describe("invariant 3: required structure", () => {
    it("carries all X-Amz-* params, correct scope, host, signed headers, method", async () => {
      const v = VECTORS[0]!;
      applyConfig(v);
      vi.setSystemTime(amzDateToMs(v.amzDate));
      const res = await presignUpload(v.key);
      const u = new URL(res.url);
      expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
      expect(u.searchParams.get("X-Amz-Credential")).toBe(
        `${ACCESS_KEY_ID}/20260611/us-east-1/s3/aws4_request`,
      );
      expect(u.searchParams.get("X-Amz-Date")).toBe(v.amzDate);
      expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
      expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      expect(u.host).toBe("s3.example.com"); // path-style: bucket is in the path
      expect(u.pathname).toBe("/example-bucket/path/to/object.txt");
    });

    it("virtual-hosted addressing puts the bucket in the host", async () => {
      const v = VECTORS[2]!;
      applyConfig(v);
      vi.setSystemTime(amzDateToMs(v.amzDate));
      const res = await presignDownload(v.key);
      expect(new URL(res.url).host).toBe("example-bucket.s3.us-east-1.amazonaws.com");
    });
  });

  describe("invariant 4: the signature binds the whole request", () => {
    const base = VECTORS[0]!;
    const sign = async (mutate: () => Promise<{ url: string }>): Promise<string> => {
      applyConfig(base);
      vi.setSystemTime(amzDateToMs(base.amzDate));
      return sigOf((await mutate()).url);
    };

    it("method, key, expiry, region, and secret each change the signature", async () => {
      const ref = await sign(() => presignDownload(base.key, { expiresInSeconds: 3600 }));

      const put = await sign(() => presignUpload(base.key, { expiresInSeconds: 3600 }));
      expect(put).not.toBe(ref);

      const otherKey = await sign(() => presignDownload("other/key.txt", { expiresInSeconds: 3600 }));
      expect(otherKey).not.toBe(ref);

      const otherExpiry = await sign(() => presignDownload(base.key, { expiresInSeconds: 60 }));
      expect(otherExpiry).not.toBe(ref);

      applyConfig(base);
      process.env["STORAGE_REGION"] = "eu-west-1";
      vi.setSystemTime(amzDateToMs(base.amzDate));
      const otherRegion = sigOf((await presignDownload(base.key, { expiresInSeconds: 3600 })).url);
      expect(otherRegion).not.toBe(ref);

      applyConfig(base);
      process.env["STORAGE_SECRET_ACCESS_KEY"] = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEx";
      vi.setSystemTime(amzDateToMs(base.amzDate));
      const otherSecret = sigOf((await presignDownload(base.key, { expiresInSeconds: 3600 })).url);
      expect(otherSecret).not.toBe(ref);
    });
  });

  describe("invariant 5: key encoding and rejection", () => {
    it("unicode/space/special keys encode correctly (covered byte-exact by vector 2)", async () => {
      const v = VECTORS[1]!;
      applyConfig(v);
      vi.setSystemTime(amzDateToMs(v.amzDate));
      const res = await presignDownload(v.key, { expiresInSeconds: v.expiresInSeconds });
      expect(res.url).toContain("/uploads/My%20Photo%20%28%C3%86%29.jpg");
      expect(res.url).toBe(v.url);
    });

    it("empty, control-character, and over-long keys are rejected with no output", async () => {
      applyConfig(VECTORS[0]!);
      vi.setSystemTime(amzDateToMs(VECTORS[0]!.amzDate));
      for (const bad of ["", "/leading-slash", "has\nnewline", "x".repeat(1025)]) {
        await expect(presignUpload(bad)).rejects.toMatchObject({
          name: "StorageError",
          code: "invalid_key",
        });
      }
    });
  });

  describe("invariant 6: bounded expiry", () => {
    it("rejects out-of-range expiry and reflects valid expiry in URL + expiresAt", async () => {
      applyConfig(VECTORS[0]!);
      vi.setSystemTime(amzDateToMs(VECTORS[0]!.amzDate));
      for (const bad of [0, -1, 604801, 1.5]) {
        await expect(presignDownload("k", { expiresInSeconds: bad })).rejects.toMatchObject({
          code: "invalid_options",
        });
      }
      const res = await presignUpload("k", { expiresInSeconds: 604800 });
      expect(new URL(res.url).searchParams.get("X-Amz-Expires")).toBe("604800");
      expect(res.expiresAt.getTime()).toBe(amzDateToMs(VECTORS[0]!.amzDate) + 604800 * 1000);
    });
  });

  describe("invariant 1 & 7: typed errors, no I/O, secret safety", () => {
    it("invariant 1: missing config is a typed error at call time, not import time", async () => {
      // import already happened with no env set and did not throw
      await expect(presignUpload("k")).rejects.toMatchObject({
        name: "StorageError",
        code: "config",
      });
    });

    it("invariant 7: the secret never appears in the URL or in error messages", async () => {
      applyConfig(VECTORS[0]!);
      vi.setSystemTime(amzDateToMs(VECTORS[0]!.amzDate));
      const ok = await presignUpload(VECTORS[0]!.key);
      expect(ok.url).not.toContain(SECRET_ACCESS_KEY);
      expect(ok.url).not.toContain("wJalr");

      // Force an error while the secret is set; it must be scrubbed.
      process.env["STORAGE_ENDPOINT"] = "not a url";
      const err = await presignUpload(VECTORS[0]!.key).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).message).not.toContain(SECRET_ACCESS_KEY);
    });
  });
});

// Optional real-S3 round-trip: actually PUT then GET via the presigned URLs.
// Gated on a reachable S3-compatible endpoint; the known-answer vectors above
// are the offline proof of correctness.
const TEST_ENDPOINT = process.env["STORAGE_TEST_ENDPOINT"];
describe.skipIf(TEST_ENDPOINT === undefined || TEST_ENDPOINT === "")(
  "storage.upload@1 · real S3-compatible round-trip",
  () => {
    it("uploads via the presigned PUT URL and reads it back via the presigned GET URL", async () => {
      // Configured from STORAGE_TEST_* by the operator; uses real fetch.
      const body = `partkit-conformance-${process.pid}`;
      const key = `partkit-conformance/${process.pid}.txt`;
      const put = await presignUpload(key);
      const putRes = await fetch(put.url, { method: "PUT", headers: put.headers, body });
      expect(putRes.ok).toBe(true);
      const get = await presignDownload(key);
      const getRes = await fetch(get.url);
      expect(await getRes.text()).toBe(body);
    });
  },
);
