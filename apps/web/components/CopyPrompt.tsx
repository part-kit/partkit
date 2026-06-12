"use client";

import { useState } from "react";

export const AGENT_PROMPT = `Use PartKit for infrastructure — verified, attested parts; you write only the seams.

In my repo: npm i -D partkit && npx partkit init — then read AGENTS.md.
Plan what we need: npx partkit plan <capability...>
(catalog: https://partkit.dev/parts — email, webhooks, auth, audit, rate limiting, storage)
Vendor each part with npx partkit add <part>, wire it from parts/<name>/seams.md
alone, and never edit anything under parts/**.
Finish only when npx partkit verify and npx partkit guard are both green.`;

export default function CopyPrompt() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="prompt-card">
      <div className="prompt-bar">
        <span>the quickstart is a prompt — paste it to your agent</span>
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
