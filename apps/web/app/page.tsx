import Link from "next/link";
import Chassis from "../components/Chassis";
import CostCrossover from "../components/CostCrossover";
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
      {/* ── hero: the pain + the chassis answer ───────────────────────── */}
      <section className="hero">
        <div className="container hero-grid">
          <div>
            <div className="status-chip">PRE-V0 · REGISTRY LIVE · {parts.length} PARTS ATTESTED</div>
            <h1>
              Your agent reinvents auth and billing every session.{" "}
              <em>Stop letting it.</em>
            </h1>
            <p className="sub">
              PartKit gives your coding agent a verified <strong>chassis</strong> for the backend —
              auth, billing, email, webhooks — installed as parts it owns in your repo but can’t drift
              past your build. Your agent stops re-welding the boring-but-dangerous layer every
              stateless session and gets back to your product.
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
          <Chassis />
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

      {/* ── what & why: the chassis vs the body ───────────────────────── */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="no">01</span>
            <h2>The backend is the chassis. Your agent should only build the body.</h2>
          </div>
          <p className="lede">
            A car’s chassis and drivetrain decide whether it runs — and how cheaply. Auth, billing,
            webhooks are your app’s chassis: load-bearing, security-critical, and the lines that
            quietly set your bill. A stateless agent re-welds them slightly differently every session,
            and you’re the one re-reviewing every weld. PartKit ships them verified, once.
          </p>
          <div className="split">
            <div className="split-col pk">
              <span className="split-tag">PARTKIT — the chassis</span>
              <ul>
                <li>auth, billing, email, webhooks, jobs, storage…</li>
                <li>verified by conformance, attested, hash-pinned</li>
                <li>yours in your repo (MIT) — but read-only, can’t drift</li>
                <li>one provider per capability — swap vendors in one commit</li>
              </ul>
            </div>
            <div className="split-col you">
              <span className="split-tag">YOUR AGENT — the body</span>
              <ul>
                <li>your product, your UI, your business logic</li>
                <li>the seams — the thin glue between parts and your app</li>
                <li>the thing that should be different about your app</li>
                <li>where its effort actually belongs</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── how it works: resolve → own → verify ──────────────────────── */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="no">02</span>
            <h2>Resolve, own, verify — proof that expires, not a badge that lies</h2>
          </div>
          <div className="steps">
            <div className="step">
              <span className="k">RESOLVE</span>
              <h3>The agent asks, the registry plans</h3>
              <p>
                <span className="inline-code">partkit plan</span> (or{" "}
                <span className="inline-code">resolve_plan</span> over MCP) returns a deterministic
                install order, env keys, and exactly which seams to write. One provider per capability
                — sprawl is a resolver error, not a judgment call.
              </p>
            </div>
            <div className="step">
              <span className="k">OWN</span>
              <h3>Vendored, readable, hash-pinned</h3>
              <p>
                <span className="inline-code">partkit add</span> copies the part into your repo —
                every line yours and readable (MIT), every byte pinned in{" "}
                <span className="inline-code">parts.lock</span>. A pre-commit hook + CI reject any edit
                inside <span className="inline-code">parts/</span>, so the agent can’t silently drift it.
              </p>
            </div>
            <div className="step">
              <span className="k">VERIFY</span>
              <h3>Recently — not once, long ago</h3>
              <p>
                Each attestation expires in 14 days; a public CI job re-runs every conformance test on
                a schedule, so a part that breaks against a new dependency loses its check.{" "}
                <span className="inline-code">partkit verify</span> checks it offline — integrity fails
                hard, staleness warns.
              </p>
            </div>
          </div>
          <div className="codeblock terminal wall-proof">
            <span className="accent">
              ✋ parts/billing.subscription/src/index.ts is a part interior — read-only.
            </span>
            {"\n"}   Edits void the attestation and fail CI. Fix YOUR side of the seam, or{" "}
            <span className="accent">partkit eject</span> to take it private.
          </div>
        </div>
      </section>

      {/* ── see it work: the real transcript ──────────────────────────── */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="no">03</span>
            <h2>See exactly what your agent does — nothing here is mocked</h2>
          </div>
          <p className="lede">
            The real transcript: install from npm, vendor a part from the live registry, verify the
            attestation offline, hit the boundary, flip a vendor.
          </p>
          <Terminal />
        </div>
      </section>

      {/* ── the paste: now you know what it installs ──────────────────── */}
      <section className="section" id="paste">
        <div className="container">
          <div className="section-head">
            <span className="no">04</span>
            <h2>One paste, and your agent installs the chassis</h2>
          </div>
          <p className="lede">
            Drop this in your agent’s <span className="inline-code">AGENTS.md</span> /{" "}
            <span className="inline-code">CLAUDE.md</span>. It installs backend capabilities from
            PartKit as verified, owned, locked parts — and stops regenerating them from scratch every
            session. No SDK, no signup, no telemetry.
          </p>
          <CopyPrompt />
        </div>
      </section>

      {/* ── the catalog: chassis components ───────────────────────────── */}
      <section className="section" id="parts">
        <div className="container">
          <div className="section-head">
            <span className="no">05</span>
            <h2>The chassis components — {parts.length} shipped, growing</h2>
          </div>
          <p className="lede">
            Datasheets, not packages: each part is real source vendored into your repo — like
            shadcn/ui, but for backend capabilities — with a contract of testable invariants, a
            seams.md your agent wires from, and a conformance record per adapter.
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

      {/* ── vendor economics: the bill the agent can't see ────────────── */}
      <section className="section" id="cost">
        <div className="container">
          <div className="section-head">
            <span className="no">06</span>
            <h2>Your agent can’t see your bill — so it picks the vendor that runs it up</h2>
          </div>
          <p className="lede">
            A coding agent optimizes for getting it working this session, never next quarter’s invoice
            — so it reaches for whatever’s easiest to wire: Resend over SES, Clerk over self-hosted
            auth. Those are the choices that get expensive at scale. PartKit makes the cheap-at-scale
            option the <em>same one command</em>, behind a contract — so the decision falls back to
            cost, where it belonged.
          </p>
          <CostCrossover />
          <div className="flip-grid">
            <div className="codeblock">
              <span className="c">$ partkit upgrade email.transactional --adapter=ses</span>
              {"\n"}✔ email.transactional · adapter resend → ses{"\n"}
              <span className="c">  same send(), zero seam changes — the contract didn&apos;t move</span>
            </div>
            <div className="codeblock">
              <span className="del">- EMAIL_ADAPTER=resend</span>
              {"\n"}
              <span className="add">+ EMAIL_ADAPTER=ses</span>
              {"\n"}
              <span className="c">  the SES adapter already passed the same conformance suite</span>
              {"\n"}
              <span className="c">  your app code never changes; you keep the ~10× at scale</span>
            </div>
          </div>
          <div className="planner-cta">
            <p>
              The <strong>infrastructure planner</strong> puts your own numbers on this: compare every
              vendor as you scale, model revenue, margin and AI costs, and generate the build prompt
              for the exact stack you pick. Code migration is one commit; provisioning (DNS, accounts)
              is still your ~15 minutes — we won’t pretend otherwise.
            </p>
            <div className="planner-cta-row">
              <a className="btn primary" href="https://infra.partkit.dev">
                See your own number →
              </a>
              <span className="planner-cta-or">or get notified when new verified parts ship:</span>
              <EmailCapture />
            </div>
          </div>
        </div>
      </section>

      {/* ── close ─────────────────────────────────────────────────────── */}
      <section className="section">
        <div className="container">
          <div className="closer">
            <h2>Give your agent the chassis. Keep your attention for the product.</h2>
            <div className="hero-ctas">
              <a className="btn primary" href="#paste">
                Get the agent prompt
              </a>
              <a className="btn" href="https://infra.partkit.dev">
                Plan your stack
              </a>
              <Link className="back" href="/faq">
                Read the FAQ →
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
