export const PARTS_START = "<!-- partkit:parts:start -->";
export const PARTS_END = "<!-- partkit:parts:end -->";
export const HOOK_MARKER = "partkit-guard";

/** Dropped into consumer repos by `partkit init` — how every agent learns the rules (docs/03 §2). */
export const AGENTS_TEMPLATE = `# PartKit — registry rules for agents

Infrastructure capabilities in this repo come from the PartKit registry.

- Before implementing auth, billing, email, jobs, storage, or uploads: run \`partkit plan "<what you need>"\` or call the registry MCP server (\`resolve_plan\`).
- **Never edit files under \`parts/**\`** — part interiors are attested; edits void the attestation and fail CI. If a part genuinely doesn't fit, the sanctioned exit is \`partkit eject <part>\`.
- Each installed part documents exactly what you must write in \`parts/<name>/seams.md\`. Write only the seams.
- Import ONLY \`parts/<name>/src/index\` — deep imports (\`src/internal/\`, \`adapters/\`) are guard failures: they couple you to interiors the attestation never promised.
- If a type error points inside \`parts/**\`, the fix is on YOUR side of the seam. Restore with \`git checkout HEAD -- parts/\` and re-read that part's seams.md.

## Installed parts
${PARTS_START}
(none yet)
${PARTS_END}
`;

/** The teaching moment (docs/06 step 6) — this text is product copy, not plumbing. */
export const GUARD_MESSAGE = `✋ Part interiors are read-only — edits void the attestation and will fail CI.

   Restore:   git checkout HEAD -- parts/
   Then change YOUR side of the seam instead.
   What each part expects from you: parts/<name>/seams.md

   Legitimate part changes go through: partkit add | partkit upgrade | partkit eject`;

/**
 * No npx here: npm 11 ignores --no-install and goes to the network, which is
 * unacceptable inside a hook. Resolve locally, then PATH, then fail closed
 * with instructions — a guard that can't run must not silently wave commits
 * through.
 */
export const PRE_COMMIT_HOOK = `#!/bin/sh
# ${HOOK_MARKER} — do not remove. Enforces the part boundary at edit time (docs/02 §7).
if [ -x "./node_modules/.bin/partkit" ]; then
  exec ./node_modules/.bin/partkit guard --staged
fi
if command -v partkit >/dev/null 2>&1; then
  exec partkit guard --staged
fi
echo "partkit: CLI not found (expected in node_modules/.bin or on PATH)." >&2
echo "Install it (npm i -D partkit) or bypass this one commit with: git commit --no-verify" >&2
exit 1
`;

export const CI_WORKFLOW = `name: partkit
on:
  push:
  pull_request:
jobs:
  parts:
    name: part boundary + attestations
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: boundary guard (the control against accident)
        run: npx --yes partkit guard
      - name: attestation verification (the control against malice)
        run: npx --yes partkit verify
`;
