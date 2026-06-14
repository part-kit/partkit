/**
 * Protocol-faithful vendor fake (docs/02 §4): a real HTTP server with
 * per-test scripted responses and full request recording, so the conformance
 * suite exercises the adapter's actual wire behavior — auth headers, payload
 * shape, retry traffic — not mocks of our own code.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface ScriptedResponse {
  status: number;
  body?: unknown;
}

export class FakeVendor {
  readonly requests: RecordedRequest[] = [];
  private readonly script: ScriptedResponse[] = [];
  private server: Server | null = null;
  private readonly successBody: () => unknown;

  constructor(successBody: () => unknown) {
    this.successBody = successBody;
  }

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = null;
        }
        this.requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body,
        });
        const scripted = this.script.shift() ?? { status: 200, body: this.successBody() };
        res.writeHead(scripted.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(scripted.body ?? {}));
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
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  }
}
