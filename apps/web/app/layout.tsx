import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://partkit.dev"),
  title: { default: "PartKit — verified standard parts for AI coding agents", template: "%s · PartKit" },
  description:
    "A neutral registry of production-grade, verified standard parts that AI coding agents trust and never regenerate. Contracts, conformance, attestations — the agent writes only the seams.",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-96x96.png", sizes: "96x96", type: "image/png" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#0a0b0d",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="container header-row">
            <Link href="/" className="wordmark" aria-label="PartKit — home">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="wordmark-symbol" src="/symbol-partkit.svg" alt="" width={23} height={19} />
              <b>
                Part<span>Kit</span>
              </b>
            </Link>
            <nav className="nav">
              <Link href="/parts">Parts</Link>
              <a href="https://demo.partkit.dev">Demo</a>
              <a href="/skills/partkit/SKILL.md">Skill</a>
              <a href="https://www.npmjs.com/package/partkit">npm</a>
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <div className="container">
            <div className="titleblock">
              <div>
                <span className="k">Title</span>
                <span className="v">PartKit — standard parts for AI coding agents</span>
              </div>
              <div>
                <span className="k">Dwg no.</span>
                <span className="v">PK-000</span>
              </div>
              <div>
                <span className="k">Rev</span>
                <span className="v">0.2.1 · pre-v0</span>
              </div>
              <div>
                <span className="k">Material</span>
                <span className="v">MIT · seams only</span>
              </div>
            </div>
            <div className="footer-meta">
              <p>
                © 2026 PartKit authors — all attestations are dev-tier until the public
                verification CI launches.
              </p>
              <p>
                <a href="https://www.npmjs.com/package/partkit">partkit</a> ·{" "}
                <a href="https://www.npmjs.com/package/@part-kit/mcp">@part-kit/mcp</a> ·{" "}
                <a href="https://registry.partkit.dev/index.json">registry.partkit.dev</a>
              </p>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
