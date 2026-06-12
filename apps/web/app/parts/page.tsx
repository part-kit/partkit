import type { Metadata } from "next";
import Link from "next/link";
import { listParts } from "../../lib/registry";

export const metadata: Metadata = { title: "Parts" };

export default async function PartsPage() {
  const parts = await listParts();
  return (
    <section className="section">
      <div className="container">
        <h2>All parts</h2>
        <p className="lede">
          The flat, two-level capability namespace is governed by RFC. Each part implements a
          versioned capability; two parts claiming the same capability version are interchangeable
          by construction.
        </p>
        <div className="grid">
          {parts.map((p) => (
            <Link key={p.name} href={`/parts/${p.name}`} className="card">
              <span className="name">{p.name}</span>
              <span className="ver">v{p.version}</span>
              <p className="desc">{p.summary ?? p.contract.invariants[0]}</p>
              <div className="badges">
                {p.contract.adapters.length === 0 ? (
                  <span className="badge seam">backend is a seam</span>
                ) : (
                  p.contract.adapters.map((a) => (
                    <span key={a.name} className={`badge ${a.status}`}>
                      {a.name}
                    </span>
                  ))
                )}
                <span className="badge">{p.contract.invariants.length} invariants</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
