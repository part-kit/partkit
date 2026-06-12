"use client";

import { useEffect, useRef, useState } from "react";

/** A stranger's first five minutes — the real transcript, typed live. */
const SCRIPT: { text: string; cls?: string; pause?: number }[] = [
  { text: "$ npm i -g partkit", cls: "cmd" },
  { text: "$ npx partkit init", cls: "cmd" },
  { text: "  + parts.lock   + AGENTS.md   + pre-commit guard   + CI verify" },
  { text: "$ npx partkit add email.transactional --adapter=resend", cls: "cmd" },
  { text: "✔ email.transactional@1.0.1 vendored into parts/", cls: "ok" },
  { text: "$ npx partkit verify", cls: "cmd" },
  { text: "✔ 1 part(s) verified — hashes match the signed attestation", cls: "ok", pause: 900 },
  { text: "$ vim parts/email.transactional/src/index.ts   # try to edit it…", cls: "cmd" },
  { text: "✋ parts/** is read-only — edits void the attestation.", cls: "wall" },
  { text: "   Fix YOUR side of the seam instead → seams.md", cls: "wall", pause: 1200 },
  { text: "$ npx partkit upgrade email.transactional --adapter=postmark", cls: "cmd" },
  { text: "✔ adapter resend → postmark · zero seam changes", cls: "ok", pause: 2400 },
];

export default function Terminal() {
  const [lines, setLines] = useState<typeof SCRIPT>([]);
  const [typed, setTyped] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setLines(SCRIPT);
      return;
    }
    let line = 0;
    let chr = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (line >= SCRIPT.length) {
        timer = setTimeout(() => {
          line = 0;
          chr = 0;
          setLines([]);
          setTyped("");
          tick();
        }, 6000);
        return;
      }
      const cur = SCRIPT[line]!;
      const isCmd = cur.cls === "cmd";
      if (isCmd && chr < cur.text.length) {
        chr += 2;
        setTyped(cur.text.slice(0, chr));
        timer = setTimeout(tick, 24);
        return;
      }
      setLines((prev) => [...prev, cur]);
      setTyped("");
      chr = 0;
      line += 1;
      timer = setTimeout(tick, cur.pause ?? (isCmd ? 80 : 260));
    };
    timer = setTimeout(tick, 800);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines, typed]);

  return (
    <div className="term" ref={box} aria-hidden>
      <div className="term-bar">
        <i /> <i /> <i />
        <span>a stranger&apos;s first five minutes — real transcript</span>
      </div>
      <div className="term-body">
        {lines.map((l, i) => (
          <div key={i} className={`tl ${l.cls ?? ""}`}>
            {l.text}
          </div>
        ))}
        {typed !== "" && (
          <div className="tl cmd">
            {typed}
            <span className="caret" />
          </div>
        )}
      </div>
    </div>
  );
}
