"use client";

/**
 * Cost-crossover chart for the homepage's vendor-economics section.
 *
 * Thesis: an AI coding agent optimizes for its own effort, not your bill — so it
 * reaches for the vendor that's easiest to wire (Resend, Clerk), which is the one
 * that gets expensive at scale. The managed line CLIMBS; the cheap/owned line
 * stays low. The drama is the growing gap, and the crossover.
 *
 * Two togglable series (EMAIL · AUTH). Pure hand-built SVG on a log-y scale so
 * both the flat line and the steep one read; lines draw in via stroke-dashoffset,
 * reduced-motion safe. No chart libs, no images.
 */
import { useState } from "react";

/* ── scale ────────────────────────────────────────────────────── */
const PX0 = 0;
const PX1 = 760; // x of the 10k .. 1M columns
const PY_TOP = 30; // y of $30,000
const PY_BOT = 360; // y of $1
const Y_MIN = 1;
const Y_MAX = 30000;

const LOG_MIN = Math.log10(Y_MIN);
const LOG_SPAN = Math.log10(Y_MAX) - LOG_MIN;

function yOf(dollars: number): number {
  const v = Math.max(dollars, Y_MIN);
  const t = (Math.log10(v) - LOG_MIN) / LOG_SPAN;
  return PY_BOT - t * (PY_BOT - PY_TOP);
}
function xOf(col: number): number {
  return PX0 + (col * (PX1 - PX0)) / 2;
}
function path(values: number[]): string {
  return values
    .map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`)
    .join(" ");
}

/* ── data (exact figures) ─────────────────────────────────────── */
type Series = {
  key: "email" | "auth";
  label: string;
  x: string[]; // column labels
  owned: number[]; // green / cheap
  managed: number[]; // accent / expensive
  ownedName: string;
  managedName: string;
  ownedEnd: string;
  managedEnd: string;
  crossoverCol: number; // column index where the gap turns punishing
  crossoverNote: string;
};

const EMAIL: Series = {
  key: "email",
  label: "Email",
  x: ["10k sends", "100k sends", "1M sends"],
  owned: [1, 10, 100],
  managed: [15, 90, 1000],
  ownedName: "Amazon SES",
  managedName: "Resend / managed",
  ownedEnd: "~$100/mo",
  managedEnd: "~$1,000/mo",
  crossoverCol: 1,
  crossoverNote: "gap widens 10×",
};

const AUTH: Series = {
  key: "auth",
  label: "Auth",
  x: ["10k MAU", "100k MAU", "1M MAU"],
  owned: [1, 1, 1],
  managed: [1, 1800, 19800],
  ownedName: "Better Auth · your Postgres",
  managedName: "Clerk / managed",
  ownedEnd: "your infra",
  managedEnd: "~$19,800/mo",
  crossoverCol: 1,
  crossoverNote: "Clerk free ≤10k MAU, then ~$0.02/MAU",
};

const SERIES: Record<Series["key"], Series> = { email: EMAIL, auth: AUTH };

/* gridlines: a decade ladder for the log axis */
const GRID = [
  { v: 1, label: "$1" },
  { v: 10, label: "$10" },
  { v: 100, label: "$100" },
  { v: 1000, label: "$1k" },
  { v: 10000, label: "$10k" },
];

export default function CostCrossover() {
  const [active, setActive] = useState<Series["key"]>("auth");
  const s = SERIES[active];

  const ownedPath = path(s.owned);
  const managedPath = path(s.managed);
  const cx = xOf(s.crossoverCol);

  return (
    <div className="crossover">
      <div className="crossover-head">
        <div className="crossover-toggle" role="tablist" aria-label="Choose a part">
          {(Object.keys(SERIES) as Series["key"][]).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={active === k}
              className={`crossover-tab${active === k ? " is-active" : ""}`}
              onClick={() => setActive(k)}
            >
              {SERIES[k].label}
            </button>
          ))}
        </div>
        <div className="crossover-legend">
          <span className="crossover-leg crossover-leg-managed">
            <i aria-hidden="true" /> {s.managedName}
          </span>
          <span className="crossover-leg crossover-leg-owned">
            <i aria-hidden="true" /> {s.ownedName}
          </span>
        </div>
      </div>

      <svg
        className="crossover-svg"
        viewBox="-46 0 1000 432"
        role="img"
        aria-label={`${s.label}: ${s.managedName} climbs to ${s.managedEnd} while ${s.ownedName} stays at ${s.ownedEnd} — the bill the agent can't see.`}
      >
        {/* horizontal grid + y labels */}
        <g className="crossover-grid">
          {GRID.map((g) => {
            const y = yOf(g.v);
            return (
              <g key={g.v}>
                <line x1={PX0} y1={y} x2={PX1} y2={y} />
                <text className="crossover-ylabel" x={PX0 - 12} y={y + 4} textAnchor="end">
                  {g.label}
                </text>
              </g>
            );
          })}
        </g>

        {/* x labels + ticks */}
        <g className="crossover-xaxis">
          {s.x.map((lbl, i) => (
            <g key={lbl}>
              <line
                className="crossover-xtick"
                x1={xOf(i)}
                y1={PY_TOP}
                x2={xOf(i)}
                y2={PY_BOT}
              />
              <text
                className="crossover-xlabel"
                x={xOf(i)}
                y={PY_BOT + 28}
                textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
              >
                {lbl}
              </text>
            </g>
          ))}
        </g>

        {/* crossover marker — the band where managed pulls away */}
        <g className="crossover-mark">
          <rect x={cx} y={PY_TOP} width={PX1 - cx} height={PY_BOT - PY_TOP} />
          <line x1={cx} y1={PY_TOP} x2={cx} y2={PY_BOT} />
          <text className="crossover-mark-label" x={cx + 10} y={PY_TOP + 18}>
            crossover
          </text>
          <text className="crossover-mark-sub" x={cx + 10} y={PY_TOP + 34}>
            {s.crossoverNote}
          </text>
        </g>

        {/* the gap, shaded between the two lines at the final column */}
        <path
          className="crossover-gap"
          d={`${managedPath} L${xOf(2)} ${yOf(s.owned[2])} L${xOf(1)} ${yOf(
            s.owned[1],
          )} L${xOf(0)} ${yOf(s.owned[0])} Z`}
        />

        {/* owned / cheap line (green) */}
        <path
          className="crossover-line crossover-line-owned"
          d={ownedPath}
          pathLength={1}
          fill="none"
        />
        {/* managed / expensive line (accent) */}
        <path
          className="crossover-line crossover-line-managed"
          d={managedPath}
          pathLength={1}
          fill="none"
        />

        {/* data dots */}
        {s.owned.map((v, i) => (
          <circle
            key={`o${i}`}
            className="crossover-dot crossover-dot-owned"
            cx={xOf(i)}
            cy={yOf(v)}
            r={3.5}
          />
        ))}
        {s.managed.map((v, i) => (
          <circle
            key={`m${i}`}
            className="crossover-dot crossover-dot-managed"
            cx={xOf(i)}
            cy={yOf(v)}
            r={3.5}
          />
        ))}

        {/* end-value callouts */}
        <g className="crossover-callout crossover-callout-managed">
          <text x={xOf(2)} y={yOf(s.managed[2]) - 14} textAnchor="end">
            {s.managedEnd}
          </text>
        </g>
        <g className="crossover-callout crossover-callout-owned">
          <text x={xOf(2)} y={yOf(s.owned[2]) - 14} textAnchor="end">
            {s.ownedEnd}
          </text>
        </g>
      </svg>

      <p className="crossover-caption">
        Published pricing · mid-2026 · re-verify before quoting.
      </p>
      <p className="crossover-caption">
        The code migration is one commit — the new adapter already passed the same
        conformance suite; provisioning (DNS, account) is still yours.
      </p>
    </div>
  );
}
