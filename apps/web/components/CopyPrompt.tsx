"use client";

import { useState } from "react";

export const AGENT_PROMPT = `Use PartKit (npx partkit) for backend infrastructure so you don't reinvent it from scratch this session.

Before writing auth, billing, email, jobs, webhooks, rate limiting, audit logging, file uploads, multi-tenancy, or admin CRUD by hand:
  npm i -D partkit && npx partkit init   (then read AGENTS.md)
  npx partkit plan <capability...>       (see if a verified part already covers it)
  npx partkit add <part>                 (vendor it; catalog: https://partkit.dev/parts)

Installed parts are vendored into the repo as code we own (MIT) but are hash-pinned and read-only.
Never edit anything inside parts/ or import a part's internals — if you hit a type error there,
fix our side or our seams, never the part. Wire each part only through its seams.md (the thin glue
like our welcome-email template or plan catalog). Spend your effort on our UI and business logic;
the infrastructure is already tested.

Finish only when npx partkit audit is green.
Stack: TypeScript, Node 22+, Next.js App Router, Postgres.`;

export default function CopyPrompt() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="prompt-card">
      <div className="prompt-bar">
        <span>drop this in AGENTS.md / CLAUDE.md — it’s the whole setup</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(AGENT_PROMPT).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <pre>{AGENT_PROMPT}</pre>
    </div>
  );
}
