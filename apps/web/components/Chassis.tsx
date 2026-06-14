/**
 * The "what is PartKit" hero schematic.
 *
 * PartKit is the CHASSIS + drivetrain of your app's backend — the load-bearing,
 * safety-critical, cost-determining layer (auth, billing, email, webhooks,
 * jobs). Your AI agent bolts the PRODUCT BODY on top. This exhibit draws that
 * literally: a solid machined chassis of labelled part-blocks settles into a
 * flush platform, then a lighter, dashed "YOUR PRODUCT" shell seats onto it
 * with glowing orange seams where the two meet — the agent writes only the
 * seams.
 *
 * Pure SVG + CSS. No runtime JS, no deps, not a client component.
 * Isometric 2:1 projection; faces match the existing hero art's palette.
 */

// ── isometric part-block ─────────────────────────────────────────────────────
// Local origin is the block's front-bottom corner. w = right-up footprint axis,
// d = right-down footprint axis, h = extruded height. 2:1 iso => +w on screen is
// (w, -w/2), +d is (d, d/2). Three visible faces + a bright top label.
function blockPaths(w: number, d: number, h: number) {
  const top = `M0 ${-h} L${w} ${-h - w / 2} L${w + d} ${-h - w / 2 + d / 2} L${d} ${-h + d / 2} Z`;
  const left = `M0 ${-h} L${d} ${-h + d / 2} L${d} ${d / 2} L0 0 Z`;
  const right = `M${d} ${-h + d / 2} L${w + d} ${-h - w / 2 + d / 2} L${w + d} ${-w / 2 + d / 2} L${d} ${d / 2} Z`;
  return { top, left, right };
}

function PartBlock({
  x,
  y,
  w,
  d,
  h,
  label,
  dx,
  dy,
  delay,
}: {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  label: string;
  dx: number;
  dy: number;
  delay: number;
}) {
  const p = blockPaths(w, d, h);
  // label centred on the bright top face
  const lx = (w + d) / 2;
  const ly = -h + (d - w) / 4 + 3.5;
  return (
    <g
      className="ch-block"
      transform={`translate(${x} ${y})`}
      style={
        {
          "--dx": `${dx}px`,
          "--dy": `${dy}px`,
          "--ch-delay": `${delay}s`,
        } as React.CSSProperties
      }
    >
      <g className="ch-block-inner">
        <path className="f-left" d={p.left} />
        <path className="f-right" d={p.right} />
        <path className="f-top" d={p.top} />
        <text className="ch-face-label" x={lx} y={ly} textAnchor="middle">
          {label}
        </text>
      </g>
    </g>
  );
}

export default function Chassis() {
  return (
    <svg
      className="chassis"
      viewBox="-170 -190 760 560"
      role="img"
      aria-label="PartKit is the verified chassis of your backend — auth, billing, email, webhooks, jobs — and your AI agent bolts your product on top; orange seams glow where they meet."
    >
      {/* ── baseplate: the ground the whole app rests on ────────────── */}
      <g className="ch-plate">
        <path className="p-top" d="M60 210 L266 106 L472 210 L266 314 Z" />
        <path className="p-left" d="M60 210 L266 314 L266 338 L60 234 Z" />
        <path className="p-right" d="M472 210 L266 314 L266 338 L472 234 Z" />
      </g>

      {/* ── PARTKIT CHASSIS: a flush 2×2 platform of load-bearing parts ─ */}
      {/* Drawn back-to-front so the isometric overlap reads correctly.   */}
      <g className="ch-chassis">
        <PartBlock x={266} y={98} w={100} d={56} h={28} label="webhooks.ingest" dx={170} dy={-130} delay={0.42} />
        <PartBlock x={210} y={70} w={100} d={56} h={28} label="auth.session" dx={150} dy={-60} delay={0.18} />
        <PartBlock x={166} y={148} w={100} d={56} h={28} label="email.transactional" dx={-70} dy={70} delay={0.54} />
        <PartBlock x={110} y={120} w={100} d={56} h={28} label="jobs.queue" dx={-210} dy={20} delay={0.3} />
      </g>

      {/* ── billing.subscription: the machined cap — the seating deck ── */}
      {/* the keystone part the product body bolts onto; settles last.    */}
      <g
        className="ch-cap"
        style={{ "--ch-delay": "0.66s" } as React.CSSProperties}
      >
        <g className="ch-cap-inner">
          <path className="cap-left" d="M126 74 L226 124 L226 140 L126 90 Z" />
          <path className="cap-right" d="M406 34 L226 124 L226 140 L406 50 Z" />
          <path className="cap-top" d="M126 74 L306 -16 L406 34 L226 124 Z" />
          <text className="cap-label" x="266" y="56" textAnchor="middle">
            billing.subscription
          </text>
        </g>
      </g>

      {/* ── YOUR PRODUCT: the lighter, dashed shell the agent builds ─── */}
      {/* A translucent outline body seated on the cap, drawn last.       */}
      <g className="ch-product">
        <path className="prod-top" d="M163 15 L295 -51 L369 -15 L237 51 Z" />
        <path className="prod-left" d="M163 15 L237 51 L237 105 L163 69 Z" />
        <path className="prod-right" d="M369 -15 L237 51 L237 105 L369 39 Z" />
        {/* vertical edge hints */}
        <path className="prod-edge" d="M163 15 L163 69" />
        <path className="prod-edge" d="M369 -15 L369 39" />
        <path className="prod-edge" d="M237 51 L237 105" />
      </g>

      {/* ── SEAMS: where the product body meets the chassis cap ─────── */}
      {/* The signature orange line — the agent writes only the seams.    */}
      <g className="ch-seams">
        {/* the product's seated base diamond (its underside) */}
        <path className="seam" pathLength={1} d="M163 69 L237 105 L369 39" />
        <path className="seam" pathLength={1} d="M163 69 L295 3 L369 39" />
        {/* the lit front vertical where the body drops onto the cap */}
        <path className="seam" pathLength={1} d="M237 51 L237 105" />
      </g>

      {/* ── layer labels ────────────────────────────────────────────── */}
      <g className="ch-layers">
        <text className="layer-label product-label" x="266" y="-84" textAnchor="middle">
          YOUR PRODUCT · YOUR AGENT BUILDS THIS
        </text>
        <text className="layer-label chassis-label" x="266" y="356" textAnchor="middle">
          PARTKIT CHASSIS · VERIFIED · LOAD-BEARING
        </text>
      </g>

      {/* ── engineering callouts: thin leaders + mono part names ─────── */}
      <g className="ch-callouts">
        <g className="callout c1">
          <path d="M310 36 L412 -14 L462 -14" />
          <circle className="dot" cx="310" cy="36" r="2.2" />
          <text x="468" y="-19">auth.session</text>
        </g>
        <g className="callout c2">
          <path d="M366 96 L428 126 L462 126" />
          <circle className="dot" cx="366" cy="96" r="2.2" />
          <text x="468" y="131">webhooks.ingest</text>
        </g>
        <g className="callout c3">
          <path d="M266 56 L360 170 L462 170" />
          <circle className="dot" cx="266" cy="56" r="2.2" />
          <text x="468" y="175">billing.subscription</text>
        </g>
        <g className="callout c4">
          <path d="M138 142 L20 80 L-30 80" />
          <circle className="dot" cx="138" cy="142" r="2.2" />
          <text x="-36" y="75" textAnchor="end">
            jobs.queue
          </text>
        </g>
        <g className="callout c5">
          <path d="M194 188 L48 130 L-30 130" />
          <circle className="dot" cx="194" cy="188" r="2.2" />
          <text x="-36" y="135" textAnchor="end">
            email.transactional
          </text>
        </g>
      </g>
    </svg>
  );
}
