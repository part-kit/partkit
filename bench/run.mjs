#!/usr/bin/env node
/**
 * PartKit multimodel benchmark runner (OpenRouter).
 *
 * Measures: can a coding agent ship the same feature with a PartKit part
 * (writing only the seams) vs from scratch — and at what cost.
 *
 *   node bench/run.mjs --model deepseek/deepseek-v4-flash --condition partkit
 *   node bench/run.mjs --model ... --condition control --runs 3
 *   node bench/run.mjs --dry --condition partkit        # build workspace only
 *
 * Fairness rules (do not break them):
 *   - identical system prompt, tools, step cap, and temperature across
 *     models and conditions;
 *   - conditions differ ONLY by workspace contents: `partkit` gets the
 *     workspace after real `partkit init` + `partkit add ratelimit.api`
 *     (vendored part + AGENTS.md boundary), `control` gets the bare fixture;
 *   - the grader is identical and black-box (HTTP only).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(BENCH_DIR);
const CLI = path.join(REPO_ROOT, "packages/cli/dist/cli.js");
const LOCAL_REGISTRY = path.join(REPO_ROOT, "registry");

const MAX_STEPS_DEFAULT = 40;
const BASH_TIMEOUT_MS = 60_000;
const TOOL_OUTPUT_LIMIT = 6_000;
const READ_LIMIT = 50_000;

/* ---------------------------------------------------------------- args */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const MODEL = arg("model", "deepseek/deepseek-v4-flash");
const CONDITION = arg("condition", "partkit");
const TASK = arg("task", "waitlist");
const RUNS = Number(arg("runs", "1"));
const MAX_STEPS = Number(arg("max-steps", String(MAX_STEPS_DEFAULT)));
const DRY = arg("dry", false) === true;

if (!["partkit", "control"].includes(CONDITION)) {
  console.error(`unknown condition: ${CONDITION}`);
  process.exit(2);
}

/* ----------------------------------------------------------- api key */

function loadApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  for (const candidate of [
    path.join(REPO_ROOT, ".env"),
    path.join(REPO_ROOT, "apps/web/.env.local"),
  ]) {
    if (!existsSync(candidate)) continue;
    const m = readFileSync(candidate, "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  }
  throw new Error("OPENROUTER_API_KEY not found (env, .env, or apps/web/.env.local)");
}

/* ------------------------------------------------------- workspaces */

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

/** Base fixture with node_modules installed, built once and cached. */
function ensureBaseFixture() {
  const base = path.join(BENCH_DIR, ".cache", `${TASK}-base`);
  const marker = path.join(base, ".bench-ready");
  if (existsSync(marker)) return base;
  mkdirSync(path.dirname(base), { recursive: true });
  cpSync(path.join(BENCH_DIR, "tasks", TASK, "fixture"), base, { recursive: true });
  console.error("· installing fixture deps (once)…");
  sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: base });
  writeFileSync(marker, "ok\n");
  return base;
}

function makeWorkspace(runId) {
  const base = ensureBaseFixture();
  const ws = path.join(BENCH_DIR, ".work", runId);
  mkdirSync(path.dirname(ws), { recursive: true });
  cpSync(base, ws, { recursive: true, verbatimSymlinks: true });
  cpSync(path.join(BENCH_DIR, "tasks", TASK, "TASK.md"), path.join(ws, "TASK.md"));

  sh("git", ["init", "-q"], { cwd: ws });
  sh("git", ["-C", ws, "config", "user.email", "bench@partkit.dev"]);
  sh("git", ["-C", ws, "config", "user.name", "partkit-bench"]);

  if (CONDITION === "partkit") {
    sh("node", [CLI, "init", "--registry", LOCAL_REGISTRY], { cwd: ws });
    sh("node", [CLI, "add", "ratelimit.api"], { cwd: ws });
  }

  sh("git", ["-C", ws, "add", "-A"]);
  sh("git", ["-C", ws, "commit", "-qm", "bench baseline"]);
  return ws;
}

/* -------------------------------------------------------------- tools */

const TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command in the project root. Killed after 60 seconds — do not start long-running servers in the foreground. Output is truncated.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file in the project (path relative to project root).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file (path relative to project root). Parent directories are created.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "Call when the task is complete and verified.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
  },
];

function clip(s, limit = TOOL_OUTPUT_LIMIT) {
  return s.length <= limit ? s : `${s.slice(0, limit)}\n…[truncated ${s.length - limit} chars]`;
}

function containedPath(workspace, p) {
  const abs = path.resolve(workspace, p);
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    throw new Error(`path escapes the project: ${p}`);
  }
  return abs;
}

async function execTool(workspace, name, args) {
  switch (name) {
    case "bash": {
      const r = spawnSync(args.command, {
        shell: true,
        cwd: workspace,
        timeout: BASH_TIMEOUT_MS,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, OPENROUTER_API_KEY: "" },
      });
      const out = [r.stdout ?? "", r.stderr ?? ""].filter(Boolean).join("\n--- stderr ---\n");
      const status = r.signal ? `killed (${r.signal})` : `exit ${r.status}`;
      return clip(`[${status}]\n${out}`);
    }
    case "read_file": {
      const abs = containedPath(workspace, args.path);
      const content = await readFile(abs, "utf8");
      return clip(content, READ_LIMIT);
    }
    case "write_file": {
      const abs = containedPath(workspace, args.path);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, args.content, "utf8");
      return `wrote ${args.path} (${args.content.length} chars)`;
    }
    default:
      return `unknown tool: ${name}`;
  }
}

/* ---------------------------------------------------------- openrouter */

async function chat(apiKey, messages, attempt = 0) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://partkit.dev",
      "X-Title": "partkit-bench",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0,
      usage: { include: true },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 2000));
      return chat(apiKey, messages, attempt + 1);
    }
    throw new Error(`openrouter ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

const SYSTEM_PROMPT = [
  "You are an autonomous coding agent working in a project directory.",
  "Start by reading TASK.md, and AGENTS.md if it exists; follow both.",
  "Use the tools to inspect the project, write code, and verify your work.",
  "Shell commands are killed after 60 seconds — never start a server in the",
  "foreground. To smoke-test, background it and curl:",
  '  bash: "(PORT=3123 npm start >/tmp/s.log 2>&1 &) ; sleep 2 ; curl -s -i http://127.0.0.1:3123/healthz ; pkill -f \'tsx server.ts\'"',
  "The grader will start the server itself afterwards.",
  `You have a budget of ${MAX_STEPS} assistant turns. When the task is complete and verified, call done.`,
].join("\n");

/* ------------------------------------------------------------ metrics */

function partsViolations(ws) {
  if (CONDITION !== "partkit") return { files: [], count: 0 };
  const out = sh("git", ["-C", ws, "status", "--porcelain", "--", "parts/"]).trim();
  const files = out ? out.split("\n").map((l) => l.trim()) : [];
  return { files, count: files.length };
}

function diffStat(ws) {
  sh("git", ["-C", ws, "add", "-A"]);
  const stat = sh("git", ["-C", ws, "diff", "--cached", "--stat", "HEAD"]).trim();
  return stat.split("\n").pop() ?? "";
}

/* ---------------------------------------------------------------- run */

async function runOnce(apiKey, index) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${MODEL.replace(/[^a-z0-9.-]/gi, "_")}-${CONDITION}-${index}`;
  const ws = makeWorkspace(runId);
  console.error(`· workspace ${ws}`);
  if (DRY) return { run_id: runId, workspace: ws, dry: true };

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "Complete the task described in TASK.md." },
  ];
  const transcript = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, cost: 0, api_calls: 0 };
  const startedAt = Date.now();
  let steps = 0;
  let outcome = "step_cap";
  let doneSummary = null;
  let idleReplies = 0;

  while (steps < MAX_STEPS) {
    steps += 1;
    const resp = await chat(apiKey, messages);
    const choice = resp.choices?.[0];
    if (!choice) throw new Error(`no choices in response: ${JSON.stringify(resp).slice(0, 300)}`);
    if (resp.usage) {
      usage.prompt_tokens += resp.usage.prompt_tokens ?? 0;
      usage.completion_tokens += resp.usage.completion_tokens ?? 0;
      usage.cost += resp.usage.cost ?? 0;
    }
    usage.api_calls += 1;

    const msg = choice.message;
    messages.push(msg);
    transcript.push({ step: steps, role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls?.map((t) => ({ name: t.function.name, arguments: clip(t.function.arguments, 2000) })) ?? null });

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      idleReplies += 1;
      if (idleReplies >= 3) {
        outcome = "stalled";
        break;
      }
      messages.push({ role: "user", content: "Continue using the tools. Call done when the task is complete." });
      continue;
    }
    idleReplies = 0;

    let finished = false;
    for (const tc of msg.tool_calls) {
      let parsed;
      try {
        parsed = JSON.parse(tc.function.arguments || "{}");
      } catch (e) {
        messages.push({ role: "tool", tool_call_id: tc.id, content: `invalid JSON arguments: ${e.message}` });
        continue;
      }
      if (tc.function.name === "done") {
        doneSummary = parsed.summary ?? "";
        messages.push({ role: "tool", tool_call_id: tc.id, content: "acknowledged" });
        finished = true;
        continue;
      }
      let result;
      try {
        result = await execTool(ws, tc.function.name, parsed);
      } catch (e) {
        result = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
      transcript.push({ step: steps, role: "tool", name: tc.function.name, result: clip(result, 2000) });
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
    if (finished) {
      outcome = "done";
      break;
    }
  }

  // stray servers from the agent's own smoke tests
  spawnSync("pkill", ["-f", ws], { encoding: "utf8" });

  const wallMs = Date.now() - startedAt;
  console.error(`· grading…`);
  const grade = spawnSync("node", [path.join(BENCH_DIR, "tasks", TASK, "check.mjs"), ws], {
    encoding: "utf8",
    timeout: 60_000,
  });
  let check = null;
  try {
    check = JSON.parse(grade.stdout);
  } catch {
    check = { passed: 0, total: 0, error: clip(`${grade.stdout}\n${grade.stderr}`, 1000) };
  }

  const violations = partsViolations(ws);
  const result = {
    run_id: runId,
    model: MODEL,
    condition: CONDITION,
    task: TASK,
    outcome,
    success: check.boot === true && check.passed === check.total && check.total > 0,
    checks_passed: `${check.passed}/${check.total}`,
    steps,
    usage,
    wall_seconds: Math.round(wallMs / 100) / 10,
    parts_violations: violations,
    diff_stat: diffStat(ws),
    done_summary: doneSummary,
    check,
    workspace: ws,
    transcript,
  };

  const outFile = path.join(BENCH_DIR, "results", `${runId}.json`);
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  const { transcript: _t, check: _c, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
  console.error(`· full result: ${path.relative(REPO_ROOT, outFile)}`);
  return result;
}

const apiKey = DRY ? "" : loadApiKey();
for (let i = 0; i < RUNS; i++) {
  await runOnce(apiKey, i);
}
