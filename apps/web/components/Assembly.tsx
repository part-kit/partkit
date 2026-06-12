/**
 * The hero exhibit: an exploded isometric assembly that locks together on
 * load — five machined parts settling onto the app's baseplate, seams
 * glowing where they meet. Pure SVG + CSS; no runtime JS, ~6 KB.
 */
const BOX_TOP = "M0 -40 L55 -72 L110 -40 L55 -8 Z";
const BOX_LEFT = "M0 -40 L55 -8 L55 32 L0 0 Z";
const BOX_RIGHT = "M110 -40 L55 -8 L55 32 L110 0 Z";

function Box({
  x,
  y,
  cls,
  dx,
  dy,
  delay,
}: {
  x: number;
  y: number;
  cls: string;
  dx: number;
  dy: number;
  delay: number;
}) {
  return (
    <g
      className={`asm-box ${cls}`}
      transform={`translate(${x} ${y})`}
      style={
        {
          "--dx": `${dx}px`,
          "--dy": `${dy}px`,
          "--asm-delay": `${delay}s`,
        } as React.CSSProperties
      }
    >
      <g className="asm-box-inner">
        <path className="f-top" d={BOX_TOP} />
        <path className="f-left" d={BOX_LEFT} />
        <path className="f-right" d={BOX_RIGHT} />
      </g>
    </g>
  );
}

export default function Assembly() {
  return (
    <svg
      className="assembly"
      viewBox="-115 -210 555 380"
      role="img"
      aria-label="Five verified parts assembling onto an application; seams glow where they meet"
    >
      {/* baseplate — the app */}
      <g className="asm-plate">
        <path className="p-top" d="M-20 10 L137 -80 L294 10 L137 100 Z" />
        <path className="p-left" d="M-20 10 L137 100 L137 124 L-20 34 Z" />
        <path className="p-right" d="M294 10 L137 100 L137 124 L294 34 Z" />
        <text className="plate-label" x="137" y="148" textAnchor="middle">
          YOUR APP — SEAMS ONLY
        </text>
      </g>

      {/* lower tier, back to front */}
      <Box x={82} y={-52} cls="b1" dx={-180} dy={-120} delay={0.15} />
      <Box x={27} y={-20} cls="b2" dx={-220} dy={-30} delay={0.3} />
      <Box x={137} y={-20} cls="b3" dx={200} dy={-90} delay={0.45} />
      <Box x={82} y={12} cls="b4" dx={160} dy={60} delay={0.6} />
      {/* top tier */}
      <Box x={82} y={-92} cls="b5" dx={0} dy={-190} delay={0.8} />

      {/* seams — drawn after the parts settle, then kept pulsing */}
      <g className="asm-seams">
        {/* top cube: lit top edge + left vertical */}
        <path className="seam" pathLength={1} d="M82 -132 L137 -100 L192 -132" />
        <path className="seam" pathLength={1} d="M82 -132 L82 -92" />
        {/* where the top cube seats on the lower tier */}
        <path className="seam" pathLength={1} d="M82 -92 L137 -60 L192 -92" />
        {/* the tier's internal cross, front arms */}
        <path className="seam" pathLength={1} d="M82 -28 L137 -60 L192 -28" />
        {/* where the tier seats on the baseplate */}
        <path className="seam" pathLength={1} d="M27 -20 L82 12 L137 44 L192 12 L247 -20" />
      </g>

      {/* engineering callouts */}
      <g className="asm-callouts">
        <g className="callout c1">
          <path d="M192 -150 L250 -178 L322 -178" />
          <text x="250" y="-184">email.transactional · 1.0.1</text>
        </g>
        <g className="callout c2">
          <path d="M10 -50 L-20 -80 L-36 -80" />
          <text x="-36" y="-86" textAnchor="end">
            audit.log
          </text>
        </g>
        <g className="callout c3">
          <path d="M192 8 L260 40 L322 40" />
          <text x="260" y="34">webhooks.ingest</text>
        </g>
        <g className="callout c4">
          <path d="M52 -6 L0 64 L-24 64" />
          <text x="-24" y="58" textAnchor="end">
            ratelimit.api
          </text>
        </g>
      </g>
    </svg>
  );
}
