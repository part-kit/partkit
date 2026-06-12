import type { Metadata } from "next";
import Link from "next/link";
import { getPart, listParts } from "../../../lib/registry";

export async function generateStaticParams() {
  return (await listParts()).map((p) => ({ part: p.name }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ part: string }>;
}): Promise<Metadata> {
  const { part } = await params;
  return { title: part };
}

export default async function PartPage({ params }: { params: Promise<{ part: string }> }) {
  const { part: name } = await params;
  const part = await getPart(name);
  const c = part.contract;

  return (
    <>
      <section className="detail-header">
        <div className="container">
          <p>
            <Link className="back" href="/parts">
              ← all parts
            </Link>
          </p>
          <h1>
            {part.name} <span className="ver">v{part.version}</span>
          </h1>
          <p className="sub">{part.summary}</p>
          <div className="badges">
            {c.provides.map((p) => (
              <span key={p} className="badge seam">
                provides {p}
              </span>
            ))}
            {c.requires.map((r) => (
              <span key={r} className="badge">
                requires {r}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <h2>Attestations</h2>
          {part.attestations.map((a) => (
            <div className="att-box" key={a.adapter ?? "default"}>
              <div>
                <span className="label">adapter</span>
                <span className="val">{a.adapter ?? "default"}</span>
              </div>
              <div>
                <span className="label">verified</span>
                <span className="val">{a.verified_at.slice(0, 10)}</span>
              </div>
              <div>
                <span className="label">expires</span>
                <span className="val">{a.expires.slice(0, 10)}</span>
              </div>
              <div>
                <span className="label">conformance</span>
                <span className="val">{a.tests_passed} tests</span>
              </div>
              <div>
                <span className="label">signature</span>
                <span className="val">{a.signature.split(":")[0]} (pre-v0)</span>
              </div>
            </div>
          ))}

          <h2 style={{ marginTop: 40 }}>Invariants</h2>
          <p className="lede">
            Testable claims, not adjectives — each maps to at least one named conformance test.
          </p>
          <ul className="invariants">
            {c.invariants.map((inv) => (
              <li key={inv}>{inv}</li>
            ))}
          </ul>

          <h2 style={{ marginTop: 40 }}>Interface</h2>
          <div className="codeblock">{c.interface.exports.join("\n")}</div>
          {c.interface.http_routes.length > 0 && (
            <table className="kv-table">
              <tbody>
                {c.interface.http_routes.map((r) => (
                  <tr key={r.route}>
                    <th>mount</th>
                    <td>
                      <code>{r.route}</code> → one-line re-export of <code>{r.export}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {Object.keys(c.env).length > 0 && (
            <>
              <h2 style={{ marginTop: 40 }}>Environment</h2>
              <table className="kv-table">
                <tbody>
                  {Object.entries(c.env).map(([key, spec]) => (
                    <tr key={key}>
                      <th>
                        <code>{key}</code>
                      </th>
                      <td>
                        {spec.required ? "required" : "optional"}
                        {spec.secret ? " · secret" : ""}
                        {spec.enum ? ` · one of: ${spec.enum.join(" | ")}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h2 style={{ marginTop: 40 }}>Seams — what your app writes</h2>
          <p className="lede">
            Sufficient without reading <code className="inline-code">src/</code>; that is part of
            the quality bar.
          </p>
          <div className="codeblock seams-pre">{part.seams}</div>

          <h2 style={{ marginTop: 40 }}>Install</h2>
          <div className="codeblock">
            <span className="c">$</span> partkit add {part.name}
            {c.adapters.length > 1
              ? ` --adapter=${c.adapters.map((a) => a.name).join("|")}`
              : ""}
          </div>
        </div>
      </section>
    </>
  );
}
