"use client";

import { useState } from "react";

// partkit.dev is a static export, so capture happens client-side: this posts
// cross-origin to the shared accounts API on infra.partkit.dev (CORS-allowed).
const API = process.env.NEXT_PUBLIC_PARTKIT_API ?? "https://infra.partkit.dev";

type Status = "idle" | "loading" | "done" | "error";

export default function EmailCapture() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [msg, setMsg] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("loading");
    setMsg("");
    try {
      const r = await fetch(`${API}/api/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, source: "homepage", notify: true }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (r.ok) setStatus("done");
      else {
        setStatus("error");
        setMsg(data.error ?? "Something went wrong.");
      }
    } catch {
      setStatus("error");
      setMsg("Network error — try again.");
    }
  };

  if (status === "done") {
    return (
      <p className="capture-done">
        ✓ You&apos;re on the list — we&apos;ll tell you when new verified parts ship and when your
        stack can get cheaper. No spam.
      </p>
    );
  }

  return (
    <form className="capture" onSubmit={submit}>
      <input
        type="email"
        required
        placeholder="you@company.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        aria-label="Email address"
      />
      <button type="submit" disabled={status === "loading"}>
        {status === "loading" ? "…" : "Notify me"}
      </button>
      {status === "error" && <span className="capture-err">{msg}</span>}
    </form>
  );
}
