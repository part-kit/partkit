#!/usr/bin/env node
/**
 * Grader for the waitlist task. Black-box: starts `npm start` in the given
 * workspace, asserts over HTTP, prints a JSON report to stdout.
 *
 *   node check.mjs <workspace> [port]
 */
import { spawn } from "node:child_process";
import process from "node:process";

const workspace = process.argv[2];
if (!workspace) {
  console.error("usage: node check.mjs <workspace> [port]");
  process.exit(2);
}
const port = Number(process.argv[3] ?? 20000 + Math.floor(Math.random() * 9999));
const base = `http://127.0.0.1:${port}`;

const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, ...(detail ? { detail } : {}) });
}

async function req(method, path, { ip, body } = {}) {
  const headers = {};
  if (ip) headers["x-forwarded-for"] = ip;
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body is fine for healthz */
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function run() {
  // 1. healthz
  const h = await req("GET", "/healthz");
  record("healthz_200", h.status === 200, `status=${h.status}`);

  // 2. ten distinct emails from one IP all accepted as new
  let distinctOk = true;
  let firstBad = "";
  for (let i = 1; i <= 10; i++) {
    const r = await req("POST", "/api/waitlist", { ip: "10.0.0.1", body: { email: `w${i}@example.com` } });
    if (r.status !== 201 || r.json?.ok !== true || r.json?.duplicate !== false) {
      distinctOk = false;
      firstBad = `request ${i}: status=${r.status} body=${r.text.slice(0, 120)}`;
      break;
    }
  }
  record("ten_distinct_201", distinctOk, firstBad);

  // 3. eleventh request from the same IP is rate limited
  const over = await req("POST", "/api/waitlist", { ip: "10.0.0.1", body: { email: "w11@example.com" } });
  const retryAfter = over.headers.get("retry-after");
  const retryNum = retryAfter === null ? NaN : Number(retryAfter);
  record(
    "eleventh_429",
    over.status === 429 && over.json?.ok === false,
    `status=${over.status} body=${over.text.slice(0, 120)}`,
  );
  record(
    "retry_after_header",
    Number.isInteger(retryNum) && retryNum >= 1 && retryNum <= 60,
    `Retry-After=${retryAfter}`,
  );

  // 4. a different IP has an independent budget
  const other = await req("POST", "/api/waitlist", { ip: "10.0.0.2", body: { email: "x1@example.com" } });
  record(
    "ip_isolation",
    other.status === 201 && other.json?.duplicate === false,
    `status=${other.status} body=${other.text.slice(0, 120)}`,
  );

  // 5. duplicate from the same IP
  const dup = await req("POST", "/api/waitlist", { ip: "10.0.0.2", body: { email: "x1@example.com" } });
  record(
    "duplicate_200",
    dup.status === 200 && dup.json?.ok === true && dup.json?.duplicate === true,
    `status=${dup.status} body=${dup.text.slice(0, 120)}`,
  );

  // 6. dedupe is global, not per client
  const cross = await req("POST", "/api/waitlist", { ip: "10.0.0.3", body: { email: "x1@example.com" } });
  record(
    "duplicate_cross_ip",
    cross.status === 200 && cross.json?.duplicate === true,
    `status=${cross.status} body=${cross.text.slice(0, 120)}`,
  );

  // 7. invalid email (fresh IP so the budget cannot interfere)
  const bad = await req("POST", "/api/waitlist", { ip: "10.0.0.4", body: { email: "nope" } });
  record(
    "invalid_email_400",
    bad.status === 400 && bad.json?.ok === false,
    `status=${bad.status} body=${bad.text.slice(0, 120)}`,
  );

  // 8. healthz is never rate limited, even from an exhausted IP
  let healthOk = true;
  for (let i = 0; i < 12; i++) {
    const r = await req("GET", "/healthz", { ip: "10.0.0.1" });
    if (r.status !== 200) {
      healthOk = false;
      break;
    }
  }
  record("healthz_unlimited", healthOk);
}

const server = spawn("npm", ["start"], {
  cwd: workspace,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const result = { passed: 0, total: 0, checks, boot: false, server_log_tail: "" };
try {
  result.boot = await waitForServer(15_000);
  if (result.boot) await run();
  else record("server_boots", false, "no 200 from /healthz within 15s");
} catch (e) {
  record("grader_error", false, e instanceof Error ? e.message : String(e));
} finally {
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

result.passed = checks.filter((c) => c.pass).length;
result.total = checks.length;
result.server_log_tail = serverLog.slice(-1500);
console.log(JSON.stringify(result, null, 2));
process.exit(result.boot && result.passed === result.total ? 0 : 1);
