#!/usr/bin/env node
/**
 * PartKit MCP server (stdio) — docs/03 §3. Stateless over the static
 * registry; contracts are immutable per version. Registry source: --registry
 * <path>, env PARTKIT_REGISTRY, or the default (hosted registry; fails with
 * an honest message until it is live).
 */
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_REGISTRY, openRegistry } from "@part-kit/core";
import {
  getAttestation,
  getContract,
  getSeams,
  getUpgradePlan,
  resolvePlanTool,
  searchParts,
} from "./tools.js";

function registrySource(): string {
  const i = process.argv.indexOf("--registry");
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1]!;
  return process.env.PARTKIT_REGISTRY ?? DEFAULT_REGISTRY;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Compact JSON — agents reread these every session; token cost is product cost. */
function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(e: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }],
    isError: true,
  };
}

/* Input schemas — ours, validated explicitly inside each handler. */
const SearchInput = z.object({
  query: z.string().describe("substring matched against names, capabilities, summaries, exports"),
});
const ContractInput = z.object({
  part: z.string().describe("part name, e.g. email.transactional"),
  version: z.string().optional().describe("default: latest"),
});
const SeamsInput = ContractInput;
const AttestationInput = z.object({
  part: z.string(),
  version: z.string().optional().describe("default: latest"),
  adapter: z.string().optional().describe("omit for parts with a single/default attestation"),
});
const UpgradeInput = z.object({ part: z.string(), from: z.string(), to: z.string() });
const ResolveInputSchema = z.object({
  capabilities: z
    .array(z.string())
    .min(1)
    .describe('e.g. ["billing.subscription", "email.transactional"]'),
  lockfile: z
    .object({
      parts: z.record(z.object({ version: z.string(), provides: z.array(z.string()) })).optional(),
    })
    .nullable()
    .optional()
    .describe("current parts.lock content; {} or omit when fresh"),
  constraints: z
    .record(z.string())
    .optional()
    .describe('e.g. { "node": "22", "framework": "next@16" }'),
  policy: z.object({ trust: z.enum(["attested-only", "allow-community"]).optional() }).optional(),
});

async function main(): Promise<void> {
  const registry = await openRegistry(registrySource());

  const server = new McpServer({ name: "partkit", version: "0.2.0" });

  /**
   * Registration shim: the SDK's generic inference over zod shapes is a
   * type-instantiation bomb (zod 3.25 ships v3+v4 surfaces; TS2589 / multi-GB
   * tsc runs). We hand the SDK the shapes for protocol-schema generation but
   * keep TypeScript out of it — handlers re-validate with the explicit
   * schemas above, so type safety lives where it is cheap and deterministic.
   */
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { description: string; inputSchema: Record<string, unknown> },
    handler: (args: unknown) => Promise<ToolResult>,
  ) => void;

  register(
    "search_parts",
    {
      description:
        "Search the PartKit registry of verified, attested standard parts. Empty query lists the whole catalog. " +
        "Returns part names, capabilities, adapters with trust tiers, and required env keys.",
      inputSchema: SearchInput.shape,
    },
    async (args) => {
      try {
        const { query } = SearchInput.parse(args);
        return json(await searchParts(registry, query));
      } catch (e) {
        return failure(e);
      }
    },
  );

  register(
    "get_contract",
    {
      description:
        "The machine-readable contract for a part: interface, invariants, env, adapters, platform, npm_dependencies.",
      inputSchema: ContractInput.shape,
    },
    async (args) => {
      try {
        const { part, version } = ContractInput.parse(args);
        return json(await getContract(registry, part, version));
      } catch (e) {
        return failure(e);
      }
    },
  );

  register(
    "get_seams",
    {
      description:
        "seams.md for a part — exactly what the app must implement, with type signatures. Sufficient without reading src/.",
      inputSchema: SeamsInput.shape,
    },
    async (args) => {
      try {
        const { part, version } = SeamsInput.parse(args);
        return json(await getSeams(registry, part, version));
      } catch (e) {
        return failure(e);
      }
    },
  );

  register(
    "get_attestation",
    {
      description:
        "The signed verification record for (part, version, adapter): conformance run, dependency matrix, expiry.",
      inputSchema: AttestationInput.shape,
    },
    async (args) => {
      try {
        const { part, version, adapter } = AttestationInput.parse(args);
        return json(await getAttestation(registry, part, version, adapter ?? null));
      } catch (e) {
        return failure(e);
      }
    },
  );

  register(
    "get_upgrade_plan",
    {
      description:
        "Upgrade path between two versions of a part: interior changes plus the seam changes the app must make.",
      inputSchema: UpgradeInput.shape,
    },
    async (args) => {
      try {
        const { part, from, to } = UpgradeInput.parse(args);
        return json(await getUpgradePlan(registry, part, from, to));
      } catch (e) {
        return failure(e);
      }
    },
  );

  register(
    "resolve_plan",
    {
      description:
        "Resolve requested capabilities against the registry and the repo's parts.lock into a deterministic, " +
        "topologically-ordered install plan: parts, adapters, env, migrations, and the seams the app must write. " +
        "Call this BEFORE implementing auth, billing, email, webhooks, jobs, storage, or rate limiting.",
      inputSchema: ResolveInputSchema.shape,
    },
    async (args) => {
      try {
        const input = ResolveInputSchema.parse(args);
        return json(
          await resolvePlanTool(registry, {
            capabilities: input.capabilities,
            ...(input.lockfile !== undefined && { lockfile: input.lockfile }),
            ...(input.constraints !== undefined && { constraints: input.constraints }),
            ...(input.policy !== undefined && { policy: input.policy }),
          }),
        );
      } catch (e) {
        return failure(e);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
