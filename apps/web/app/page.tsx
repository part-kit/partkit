import Link from "next/link";
import Assembly from "../components/Assembly";
import CopyPrompt from "../components/CopyPrompt";
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
              Standard parts for AI&nbsp;coding agents. <em>The agent writes only the seams.</em>
            </h1>
            <p className="sub">
              Every capability ships as a <strong>part</strong>: vendored code with a
              machine-readable contract, a conformance suite every adapter must pass, and an
              attestation that expires — so “verified” always means <em>recently</em>.
            </p>
            <div className="hero-ctas">
              <div className="install">
                <span className="dollar">$</span>
                <span>npm i -g partkit</span>
              </div>
              <Link className="btn primary" href="/parts">
                Browse the catalog
              </Link>
              <a className="btn" href="https://demo.partkit.dev">
                Live demo
              </a>
            </div>
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

      <section className="section" id="prompt">
        <div className="container">
          <div className="section-head">
            <span className="no">00</span>
            <h2>Your agent does this, not you</h2>
          </div>
          <p className="lede">
            PartKit is agent-first: the quickstart is not a tutorial, it is a prompt. Paste it into
            Claude Code (or any harness with the CLI available) and watch the guards hold.
          </p>
          <CopyPrompt />
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="no">01</span>
            <h2>Watch it, end to end</h2>
          </div>
          <p className="lede">
            Install from npm, vendor a part from the live registry, verify the attestation
            offline, hit the boundary, flip a vendor. Nothing below is mocked — it is the real
            transcript.
          </p>
          <Terminal />
        </div>
      </section>

      <section className="section" id="parts">
        <div className="container">
          <div className="section-head">
            <span className="no">02</span>
            <h2>The catalog</h2>
          </div>
          <p className="lede">
            Datasheets, not packages: a contract of testable invariants, seams documentation an
            agent wires from without reading the source, and a signed conformance record per
            adapter.
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
            <span className="no">03</span>
            <h2>The flip</h2>
          </div>
          <p className="lede">
            Contracts erase the developer-experience differences between vendors, so switching is
            policy, not surgery. This is the entire diff of a vendor change:
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

      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="no">04</span>
            <h2>How it works</h2>
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
              <h3>Owned, readable, untouchable</h3>
              <p>
                <span className="inline-code">partkit add</span> copies the part into your repo —
                every line readable, every byte hash-pinned in{" "}
                <span className="inline-code">parts.lock</span> to exactly what the attestation
                signs.
              </p>
            </div>
            <div className="step">
              <span className="k">VERIFY</span>
              <h3>Trust that expires</h3>
              <p>
                <span className="inline-code">partkit verify</span> checks every attestation
                offline in CI. Integrity failures fail hard; staleness only warns — our bad
                weekend never reddens your build.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="no">05</span>
            <h2>The wall</h2>
          </div>
          <p className="lede">
            When an agent pattern-matches a type error into “let me edit the library,” it hits the
            boundary — and learns, in context, how the system works.
          </p>
          <div className="codeblock terminal">
            <span className="accent">
              ✋ parts/billing.subscription/src/index.ts is a part interior — read-only.
            </span>
            {"\n"}   Edits void the attestation and will fail CI.{"\n"}   Fix: git checkout HEAD --
            parts/ , then change YOUR side of the seam.{"\n"}   What this part expects from you:
            parts/billing.subscription/seams.md
          </div>
        </div>
      </section>
    </>
  );
}
