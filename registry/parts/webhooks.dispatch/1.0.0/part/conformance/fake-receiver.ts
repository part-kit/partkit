/**
 * A protocol-faithful fake RECEIVER — the inverse of webhooks.ingest's
 * fake-sender (RFC 0003 §4). A real local HTTP server that verifies the Standard
 * Webhooks signature with the shared secret and can be scripted to return
 * 200/500/429/slow. Its verifier is written INDEPENDENTLY from the part's signer
 * (from the spec), so a wire-format bug in the part fails the suite rather than
 * being masked by shared code.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Captured {
  headers: Record<string, string>;
  body: string;
  verified: boolean;
  at: number;
}

type Responder = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export class FakeReceiver {
  private server: Server | undefined;
  port = 0;
  readonly received: Captured[] = [];
  /** FIFO queue of responders; default 200 when empty. */
  readonly script: Responder[] = [];

  constructor(private readonly secret: string) {}

  url(path = "/hook"): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  /** Independent Standard Webhooks verification (spec, not the part's code). */
  private verify(headers: Record<string, string>, raw: string): boolean {
    const id = headers["webhook-id"];
    const ts = headers["webhook-timestamp"];
    const sigHeader = headers["webhook-signature"];
    if (id === undefined || ts === undefined || sigHeader === undefined) return false;
    const key = Buffer.from(this.secret.replace(/^whsec_/, ""), "base64");
    const expected = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest();
    return sigHeader.split(" ").some((entry) => {
      const comma = entry.indexOf(",");
      if (comma === -1 || entry.slice(0, comma) !== "v1") return false;
      let got: Buffer;
      try {
        got = Buffer.from(entry.slice(comma + 1), "base64");
      } catch {
        return false;
      }
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? (v[0] ?? "") : String(v);
        }
        this.received.push({ headers, body: raw, verified: this.verify(headers, raw), at: Date.now() });
        const next = this.script.shift();
        if (next) {
          void Promise.resolve(next(req, res)).catch(() => {
            if (!res.headersSent) res.writeHead(500);
            res.end();
          });
        } else {
          res.writeHead(200);
          res.end("ok");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Declarative response helpers for the script queue.
export const ok = (_q: IncomingMessage, r: ServerResponse): void => {
  r.writeHead(200);
  r.end("ok");
};
export const fail500 = (_q: IncomingMessage, r: ServerResponse): void => {
  r.writeHead(500);
  r.end("boom");
};
export const bad400 = (_q: IncomingMessage, r: ServerResponse): void => {
  r.writeHead(400);
  r.end("nope");
};
export const rate429 = (afterSeconds: number) => (_q: IncomingMessage, r: ServerResponse): void => {
  r.writeHead(429, { "retry-after": String(afterSeconds) });
  r.end();
};
