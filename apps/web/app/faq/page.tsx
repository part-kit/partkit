import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "Plain answers about PartKit — how verified, owned, locked backend parts let your AI agent stop reinventing infrastructure, and you stop re-reviewing it.",
};

const FAQS: { q: string; a: ReactNode }[] = [
  {
    q: "Isn’t this just a boilerplate, or shadcn, or an npm package?",
    a: (
      <>
        No. A boilerplate you fork once and maintain forever — it drifts, and nothing re-verifies
        it. An npm package is a hidden dependency that changes under you. shadcn is the same
        vendoring idea for UI, with no verification. PartKit is vendored code you own <em>plus</em> a
        machine-readable contract, a conformance suite, an attestation that expires, and a lock that
        stops your agent drifting it.
      </>
    ),
  },
  {
    q: "My agent writes me custom code. Why would I want “standard” infrastructure?",
    a: (
      <>
        Custom is exactly the problem for auth, billing, and webhooks: a stateless agent writes them
        a little differently every session, and the differences are where the bugs live. You want
        these boringly identical and tested — and your agent’s creativity spent on your product, not
        on re-deriving a session check for the hundredth time.
      </>
    ),
  },
  {
    q: "Can my agent actually not edit the parts?",
    a: (
      <>
        It can write the file — but a pre-commit hook and CI reject the change, so it can’t land past
        your build, and an import-boundary scan blocks reaching into a part’s internals. In practice
        the agent reads the rule in <code>AGENTS.md</code>, hits the wall once, and goes back to
        wiring the seams.
      </>
    ),
  },
  {
    q: "What if I need to change a part?",
    a: (
      <>
        Two doors. Flip its vendor in one commit (<code>partkit upgrade --adapter=</code>), or{" "}
        <code>partkit eject</code> to take full ownership and hand-edit it. The lock is a default you
        can opt out of, not a prison.
      </>
    ),
  },
  {
    q: "What’s a seam?",
    a: (
      <>
        The thin app-specific glue where a part meets your product — the only code your agent writes
        for that capability. The email part sends mail; your seam is your welcome-email template. The
        billing part talks to Stripe; your seam is your plan catalog. Every part ships a{" "}
        <code>seams.md</code> so your agent wires it without ever reading the interior.
      </>
    ),
  },
  {
    q: "What does “verified” actually mean — is it cryptographically signed?",
    a: (
      <>
        It means the part’s conformance suite passed and the proof hasn’t expired — a 14-day window,
        re-run on a public schedule, so a part that breaks against a new dependency goes visibly
        stale instead of silently wrong. It is <strong>not</strong> cryptographically signed yet;
        attestations are dev-tier and real signing is on the roadmap. We’d rather say so than imply
        more.
      </>
    ),
  },
  {
    q: "I don’t really read the code I ship. Does this still help me?",
    a: (
      <>
        Especially you. The parts most likely to bite you — auth, billing, webhooks, secrets — come
        in already tested and locked, so the code you can’t review is the code you didn’t have to.
        You still own and review the thin seams on top; everything below them is tested code.
      </>
    ),
  },
  {
    q: "Is it a dependency or a service I’m locking into?",
    a: (
      <>
        Neither. <code>partkit add</code> copies the source into your repo (MIT) — no runtime, no
        server in your request path, no account. The registry is consulted only when you install or
        upgrade. <code>partkit verify</code> runs fully offline, and there’s no telemetry.
      </>
    ),
  },
  {
    q: "Which stacks does it support?",
    a: (
      <>
        v0 is deliberately narrow: TypeScript, Node 22+, Next.js App Router, and Postgres — one
        reference stack many parts deep, rather than many stacks one part deep. The contract format
        is stack-agnostic by design; more stacks come after real projects ship on this one.
      </>
    ),
  },
  {
    q: "What does it cost?",
    a: (
      <>
        The registry, the CLI, and every part are free and open source (MIT). The eventual business
        is certification and private registries for teams — which only works if the public registry
        stays neutral, so PartKit certifies vendors and sells none of them.
      </>
    ),
  },
];

export default function FAQPage() {
  return (
    <section className="section">
      <div className="container">
        <div className="section-head">
          <span className="no">FAQ</span>
          <h2>Questions a skeptic asks</h2>
        </div>
        <p className="lede">
          Plain answers — for the engineer who reviews everything and the builder who reviews
          nothing.
        </p>
        <div className="faq">
          {FAQS.map((f) => (
            <div key={f.q} className="faq-item">
              <h3 className="faq-q">{f.q}</h3>
              <p className="faq-a">{f.a}</p>
            </div>
          ))}
        </div>
        <p className="lede" style={{ marginTop: "32px" }}>
          Ready? <Link className="back" href="/#paste">Get the agent prompt →</Link>
        </p>
      </div>
    </section>
  );
}
