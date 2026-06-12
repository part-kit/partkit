# bench — multimodel PartKit benchmark

Measures the PartKit claim with numbers: *an agent that writes only the seams
ships the same feature more reliably and more cheaply than an agent building
from scratch* — across models, including cheap ones.

## Design

One neutral agent loop (`run.mjs`) over the OpenRouter chat-completions API.
Every model gets the **identical** scaffold: same system prompt, same four
tools (`bash`, `read_file`, `write_file`, `done`), same step cap (40), same
temperature (0), same grader.

Two conditions, differing **only by workspace contents**:

- **`partkit`** — the fixture after a real `partkit init` +
  `partkit add ratelimit.api` against the local registry: vendored part,
  `parts.lock`, the `AGENTS.md` boundary. The agent's job is the seams.
- **`control`** — the bare fixture. The agent builds everything itself.

The grader (`tasks/<task>/check.mjs`) is black-box: it starts `npm start`
itself and asserts over HTTP only. It never reads the agent's code.

## Metrics per run

- `success` — all grader checks pass (binary), plus `checks_passed` for partial credit
- `steps` / `usage.api_calls` — agent turns consumed
- `usage.prompt_tokens` / `completion_tokens` / `cost` — from OpenRouter usage accounting (real billed cost, not estimated)
- `wall_seconds`
- `parts_violations` — files touched under `parts/**` (the boundary the attestation depends on; any entry is a safety failure even if checks pass)
- `diff_stat` — how much code the agent had to write

## Running

```sh
node bench/run.mjs --model deepseek/deepseek-v4-flash --condition partkit
node bench/run.mjs --model deepseek/deepseek-v4-flash --condition control
node bench/run.mjs --model google/gemini-3.5-flash --condition partkit --runs 3
node bench/run.mjs --dry --condition partkit   # build a workspace, no API calls
```

Key: `OPENROUTER_API_KEY` from the environment, repo-root `.env`, or
`apps/web/.env.local` (all gitignored). Results land in `bench/results/`
(gitignored — review before anything is published).

Roster: `models.json`. Tasks: `tasks/<name>/{TASK.md,fixture/,check.mjs}`.

## Fairness notes

- The partkit condition measures *post-add* work: `init`/`add` run at fixture
  build time, by us, with the real CLI. What's compared is the agent work,
  which is PartKit's actual claim ("the agent writes only the seams").
- Both fixtures carry `tsx` so TypeScript runs identically in both conditions;
  the control agent is free to `npm install` anything else.
- Per-run cost comes from OpenRouter's usage accounting, not from our own
  price table.
- Multiple runs per cell (`--runs`) before drawing conclusions; temperature 0
  reduces but does not remove variance.
