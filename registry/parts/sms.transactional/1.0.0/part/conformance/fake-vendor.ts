/**
 * Protocol-faithful vendor fake (docs/02 §4): a real HTTP server with per-test
 * scripted responses and full request recording, so the conformance suite
 * exercises the adapter's actual wire behavior — auth headers, the form body it
 * POSTs, retry traffic — not mocks of our own code. Records the RAW body and a
 * best-effort parse (form-urlencoded for Twilio/SNS, JSON if so labelled), and
 * replies with a per-vendor content-type (Twilio JSON / SNS XML).
 */
import { Buffer } from "node:buffer";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  body: Record<string, string>;
}

export interface ScriptedResponse {
  status: number;
  /** Raw response body string (XML for SNS, JSON for Twilio). */
  body?: string;
  contentType?: string;
  /** Abruptly drop the connection instead of responding (simulate a network failure). */
  networkError?: boolean;
}

function parseBody(raw: string, contentType: string): Record<string, string> {
  if (raw === "") return {};
  if (contentType.includes("application/json")) {
    try {
      const o: unknown = JSON.parse(raw);
      return o !== null && typeof o === "object" ? (o as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

export class FakeVendor {
  readonly requests: RecordedRequest[] = [];
  private readonly script: ScriptedResponse[] = [];
  private server: Server | null = null;
  private readonly success: () => ScriptedResponse;

  constructor(success: () => ScriptedResponse) {
    this.success = success;
  }

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        this.requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          raw,
          body: parseBody(raw, String(req.headers["content-type"] ?? "")),
        });
        const scripted = this.script.shift() ?? this.success();
        if (scripted.networkError === true) {
          req.socket.destroy(); // drop the connection → fetch rejects → vendorNetworkError (retryable)
          return;
        }
        res.writeHead(scripted.status, { "Content-Type": scripted.contentType ?? "application/json" });
        res.end(scripted.body ?? "");
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  /** Queue responses for upcoming requests; unscripted requests succeed. */
  scriptNext(...responses: ScriptedResponse[]): void {
    this.script.push(...responses);
  }

  reset(): void {
    this.requests.length = 0;
    this.script.length = 0;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server !== null) {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }
}
