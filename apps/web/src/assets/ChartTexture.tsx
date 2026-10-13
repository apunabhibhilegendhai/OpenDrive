/**
 * The chart-table layer.
 *
 * A single fixed, non-interactive drawing that sits behind the workspace: contour lines, a fine
 * graticule, a few depth soundings and a dashed rhumb-line rosette — the surface a navigator would
 * pin charts to. It is drawn with `currentColor` at very low opacity, so both themes get it and no
 * text ever sits on a busy area (the content column carries its own opaque surfaces).
 *
 * `aria-hidden` by definition: it carries no information.
 */
export function ChartTexture() {
  const soundings = [
    { x: 120, y: 210, text: '32' },
    { x: 320, y: 160, text: '18' },
    { x: 640, y: 300, text: '7' },
    { x: 980, y: 180, text: '45' },
    { x: 1240, y: 420, text: '26' },
    { x: 460, y: 520, text: '12' },
    { x: 860, y: 560, text: '3' },
    { x: 1120, y: 660, text: '58' },
  ];
  const graticule = Array.from({ length: 16 }, (_, index) => index * 100 + 40);
  const meridians = Array.from({ length: 10 }, (_, index) => index * 160 + 80);

  return (
    <svg
      className="chartlayer"
      viewBox="0 0 1480 760"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <g className="chartlayer__grid" stroke="currentColor" strokeWidth="0.6">
        {graticule.map((y) => (
          <line key={`h${y}`} x1="0" y1={y} x2="1480" y2={y} />
        ))}
        {meridians.map((x) => (
          <line key={`v${x}`} x1={x} y1="0" x2={x} y2="760" />
        ))}
      </g>

      <g className="chartlayer__contours" fill="none" stroke="currentColor" strokeWidth="1.1">
        <path d="M40 700c120-90 60-200 180-250s260 40 320-80 20-230 180-260" />
        <path d="M40 730c130-95 70-210 195-262s270 42 332-84 22-238 186-268" />
        <path d="M900 760c60-140 220-160 300-260s40-220 200-240" />
        <path d="M940 760c62-146 228-166 310-268s42-228 208-248" />
      </g>

      <g
        className="chartlayer__rhumb"
        stroke="currentColor"
        strokeWidth="0.9"
        strokeDasharray="7 9"
      >
        <circle cx="1180" cy="180" r="120" fill="none" />
        <path d="M1180 40v280M1040 180h280M1081 81l198 198M1279 81l-198 198" />
      </g>

      <g
        className="chartlayer__sounds"
        fill="currentColor"
        fontFamily="var(--font-mono)"
        fontSize="13"
      >
        {soundings.map((sounding) => (
          <text key={`${sounding.x}-${sounding.y}`} x={sounding.x} y={sounding.y}>
            {sounding.text}
          </text>
        ))}
      </g>
    </svg>
  );
}
