# Working rules for agents in this repo

This is the PartKit monorepo itself (registry + CLI), not a consumer app.

- `docs/` is the source of truth. `docs/06-agent-walkthrough.md` is the acceptance fixture: the CLI and MCP server are built to reproduce that transcript. If implementation and docs disagree, stop and reconcile both — don't silently drift.
- Schema changes in `packages/core` (contract, lockfile, attestation) must be reflected in `docs/02-part-specification.md`, and vice versa.
- The root `tsconfig.base.json` is the strict-compile gate from docs/02 §4 (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). Never weaken it — parts are held to it, so we are too.
- Run `npm run check` (typecheck + tests) before claiming anything works.
- `registry/` content is governed: capability additions and version bumps go by RFC (docs/02 §3). Part authorship follows `docs/07-part-author-manual.md` — the exemplar is `registry/parts/email.transactional/1.0.0/`; publish via `npm run registry:publish`.
- If you were asked to "build the next part", docs/07 §Launch prompt is your instruction set; follow its process and human checkpoints exactly.
- **Concurrent sessions share this tree's one HEAD.** Stage with explicit paths only — never `git add -A`/`git add .` (it sweeps another session's in-progress files into your commit; this happened on 2026-06-11). Run `git status` and `git branch --show-current` immediately before any commit or branch switch; unexpected files or an unexpected branch mean another session is active — stop and flag it. Best: take an isolated checkout via `git worktree add ../partkit-<task>` and work there.
- **In a fresh worktree, run a real `npm install` — do NOT symlink `node_modules` from the main tree.** A symlinked `node_modules` breaks `tsc -b` (project references / type resolution go sideways — zod infers `unknown`, wrong call overloads), which looks like a code bug but is the worktree setup. A real install in the worktree compiles correctly (verified 2026-06-12). If install cost is a concern, fall back to branch-in-main with explicit-path staging (above) when the tree is clean — but never symlink.
