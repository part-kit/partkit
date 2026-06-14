import Link from "next/link";
import Assembly from "../components/Assembly";
import CopyPrompt from "../components/CopyPrompt";
import EmailCapture from "../components/EmailCapture";
import Terminal from "../components/Terminal";
import { listParts } from "../lib/registry";

export default async function Home() {
  const parts = await listParts();
  const adapterCount = parts.reduce((n, p) => n + p.contract.adapters.length, 0);
  const invariantCount = parts.reduce((n, p) => n + p.contract.invariants.length, 0);
  const testCount = parts.reduce(
    (n, p) => n + p.attestations.reduce((m, a) => Math.max(m, a.tests_passed), 0),
    0,
  );

  return (
    <>
      <section className="hero">
        <div className="container hero-grid">
          <div>
            <div className="status-chip">PRE-V0 · REGISTRY LIVE · {parts.length} PARTS ATTESTED</div>
            <h1>
              Your agent reinvents auth and billing every session.{" "}
              <em>Stop letting it.</em>
            </h1>
            <p className="sub">
              You don’t let it redraw the button every chat — but auth, billing, email, and webhooks
              get rebuilt slightly differently each stateless session, and you’re the one
              re-reviewing every line. PartKit installs them as verified <strong>parts</strong> your
              agent owns in your repo but can’t drift past your build. You stop re-reviewing the
              boring-but-dangerous layer; your agent gets back to your product.
            </p>
            <div className="hero-ctas">
              <div className="install">
                <span className="dollar">$</span>
                <span>npm i -D partkit</span>
              </div>
              <a className="btn primary" href="#paste">
                Get the agent prompt
              </a>
              <Link className="btn" href="/parts">
                Browse the catalog
              </Link>
            </div>
            <p className="hero-meta">
              TypeScript · Node 22+ · Next.js App Router · Postgres — {parts.length} parts shipped,
              dev-tier attestations (real signing on the roadmap).
            </p>
          </div>
          <Assembly />
        </div>
      </section>

      <div className="container">
        <div className="stats">
          <div className="stat">
            <div className="n">{parts.length}</div>
            <div className="l">parts in the registry</div>
          </div>
          <div className="stat">
            <div className="n">{invariantCount}</div>
            <div className="l">contract invariants</div>
          </div>
          <div className="stat">
            <div className="n">{testCount}+</div>
            <div className="l">conformance tests / run</div>
          </div>
          <div className="stat">
            <div className="n">{adapterCount}</div>
            <div className="l">attested adapters</div>
          </div>
          <div className="stat">
            <div className="n">0</div>
            <div className="l">lines an agent edits inside parts/</div>
          </div>
        </div>
      </div>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="no">00</span>
            <h2>The code you can least afford to skim is the code your agent rewrites most</h2>
          </div>
          <p className="lede">
            Writing code is cheap now; reviewing it is the bottleneck. A stateless agent has no
            memory of how it did auth last Tuesday, so it improvises again — a slightly different
            session check, a new webhook verifier, another way to store a token. Each variation is a
            place a bug hides, and auth, billing, and secrets are exactly the lines you can’t eyeball
            for correctness. That’s the layer PartKit takes off your plate.
          </p>
        </div>
      </section>

      <section className="section" id="paste">
        <div className="container">
          <div className="section-head">
            <span className="no">01</span>
            <h2>Paste this into your agent’s AGENTS.md or CLAUDE.md</h2>
          </div>
          <p className="lede">
            This is the block you copy. Drop it in your agent file and your coding agent installs
            backend capabilities from PartKit as verified, owned, locked parts — and stops
            regenerating auth, billing, and webhooks from scratch every session. No SDK, no signup,
            no telemetry.
          </p>
          <CopyPrompt />
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="no">02</span>
            <h2>See exactly what your agent does</h2>
          </div>
          <p className="lede">
            Install from npm, vendor a part from the live registry, verify the attestation offline,
            hit the boundary, flip a vendor. Nothing below is mocked — it’s the real transcript.
          </p>
          <Terminal />
        </div>
      </section>

      <section className="section" id="parts">
        <div className="container">
          <div className="section-head">
            <span className="no">03</span>
            <h2>The backend your agent stops reinventing</h2>
          </div>
          <p className="lede">
            Datasheets, not packages: each part is real source vendored into your repo — like
            shadcn/ui, but for backend capabilities — with a contract of testable invariants, a
            seams.md your agent wires from without reading the source, and a conformance record per
            adapter. {parts.length} shipped today.
          </p>
          <div className="grid">
            {parts.map((p) => (
              <Link key={p.name} href={`/parts/${p.name}`} className="sheet">
                <div className="sheet-head">
                  <span className="pn">{p.name}</span>
                  <span className="rev">REV {p.version}</span>
                </div>
                <div className="stamp">
                  PARTKIT
                  <br />
                  ATTESTED
                  <br />
                  DEV·TIER
                </div>
                <div className="sheet-body">
                  <p className="desc">{p.summary ?? p.contract.invariants[0]}</p>
                  <div className="specrow">
                    <span>INVARIANTS</span>
                    <b>{p.contract.invariants.length} testable claims</b>
                  </div>
                  <div className="specrow">
                    <span>ADAPTERS</span>
                    <b>
                      {p.contract.adapters.length === 0
                        ? "backend is a seam"
                        : p.contract.adapters.map((a) => a.name).join(" · ")}
                    </b>
                  </div>
                  <div className="specrow">
                    <span>CONFORMANCE</span>
                    <b>{Math.max(0, ...p.attestations.map((a) => a.tests_passed))} tests / adapter</b>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="no">04</span>
            <h2>Outgrow a vendor? Re-point it in one commit</h2>
          </div>
          <p className="lede">
            Every adapter passes the same conformance suite, so providers are interchangeable
            wherever a part ships one — your seams and product code never move. This is the entire
            diff of an email-vendor change. The code change is one commit; the production migration
            (domains, deliverability) is still yours, but your app isn’t rewritten and it’s never
            locked to a vendor.
          </p>
          <div className="flip-grid">
            <div className="codeblock">
              <span className="c">$ partkit upgrade email.transactional --adapter=postmark</span>
              {"\n"}✔ email.transactional · adapter resend → postmark{"\n"}
              <span className="c">  zero seam changes — the contract didn&apos;t move</span>
            </div>
            <div className="codeblock">
              <span className="del">- &quot;adapter&quot;: &quot;resend&quot;,</span>
              {"\n"}
              <span className="add">+ &quot;adapter&quot;: &quot;postmark&quot;,</span>
              {"\n"}
              <span className="del">- EMAIL_ADAPTER=resend</span>
              {"\n"}
              <span className="add">+ EMAIL_ADAPTER=postmark</span>
              {"\n"}
              <span className="c">  parts/…/adapters/selected/ swapped, hash-pinned</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="cost">
        <div className="container">
          <div className="section-head">
            <span className="no">05</span>
            <h2>What will this cost at 10,000 users?</h2>
          </div>
          <p className="lede">
            The question every builder asks — and rarely answers before the bill arrives. Most
            parts run on the Postgres you already have, so they cost nothing per capability; for
            the metered ones you pick the cheapest vendor and flip in one commit. We built a free,
            vendor-neutral planner that works the whole thing out.
          </p>
          <div className="planner-cta">
            <p>
              The <strong>PartKit infrastructure planner</strong> compares every vendor’s real cost
              as you scale — Neon vs Supabase, self-host vs Clerk, R2 vs S3, BaaS bundles vs à la
              carte — models revenue, margin and AI-API costs, and hands your agent a
              ready-to-paste build prompt for the exact stack you choose.
            </p>
            <div className="planner-cta-row">
              <a className="btn primary" href="https://infra.partkit.dev">
                Open the planner →
              </a>
              <span className="planner-cta-or">or get notified when new verified parts ship:</span>
              <EmailCapture />
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="no">06</span>
            <h2>Verified recently — not once, long ago</h2>
          </div>
          <div className="steps">
            <div className="step">
              <span className="k">RESOLVE</span>
              <h3>The agent asks, the registry plans</h3>
              <p>
                <span className="inline-code">resolve_plan</span> over MCP (or{" "}
                <span className="inline-code">partkit plan</span>) returns a deterministic install
                order, env keys, and exactly which seams the app must write. One provider per
                capability per repo — sprawl is a resolver error.
              </p>
            </div>
            <div className="step">
              <span className="k">VENDOR</span>
              <h3>Owned, readable, hash-pinned</h3>
              <p>
                <span className="inline-code">partkit add</span> copies the part into your repo —
                every line readable and yours (MIT), every byte hash-pinned in{" "}
                <span className="inline-code">parts.lock</span> to exactly what the attestation
                covers.
              </p>
            </div>
            <div className="step">
              <span className="k">VERIFY</span>
              <h3>Proof that expires, not a badge that lies</h3>
              <p>
                Each attestation expires in 14 days and a public CI job re-runs every conformance
                test on a schedule, so a part that breaks against a new dependency loses its check.{" "}
                <span className="inline-code">partkit verify</span> checks it offline — integrity
                fails hard, staleness only warns.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="no">07</span>
            <h2>Owned by you — but your agent can’t drift it</h2>
          </div>
          <p className="lede">
            The interior is hash-pinned in <span className="inline-code">parts.lock</span> and
            read-only: a pre-commit hook, an import-boundary scanner, and CI reject any edit inside
            parts/ or any import of a part’s internals. When an agent pattern-matches a type error
            into “let me just edit the library,” it hits the wall and learns, in context, how the
            system works.
          </p>
          <div className="codeblock terminal">
            <span className="accent">
              ✋ parts/billing.subscription/src/index.ts is a part interior — read-only.
            </span>
            {"\n"}   Edits void the attestation and will fail CI.{"\n"}   Fix: git checkout HEAD --
            parts/ , then change YOUR side of the seam.{"\n"}   What this part expects from you:
            parts/billing.subscription/seams.md
          </div>
          <p className="lede">
            Need to take a part private and hand-edit it? <span className="inline-code">partkit
            eject</span> moves it out of the boundary in one command — the lock is a choice, not a
            cage. <Link className="back" href="/faq">Read the FAQ →</Link>
          </p>
        </div>
      </section>
    </>
  );
}
