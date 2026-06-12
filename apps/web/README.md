# partkit.dev

The static site **and** the hosted registry in one deployment: `prebuild` mirrors
`../../registry` into `public/registry/`, and `vercel.json` host-rewrites
`registry.partkit.dev/*` onto that path. Pages render at build time from the
registry directory — no CMS, no server, single source of truth.

## One-time Vercel setup

1. Import the repo at vercel.com/new (private repos work — no need to go public).
2. **Root Directory:** `apps/web` (leave "Include source files outside Root Directory" ON — the build reads `../../registry`).
3. Framework preset: Next.js (auto-detected). No env vars needed.
4. Domains: add `partkit.dev` **and** `registry.partkit.dev` to this project.
   The host rewrite in `vercel.json` makes the second one serve the registry.

After the first deploy:

```bash
curl https://registry.partkit.dev/index.json        # the registry is live
partkit init && partkit add ratelimit.api           # the CLI default just works
```

## Local

```bash
npm run dev -w apps/web      # dev server
npm run build -w apps/web    # static export to out/
```
