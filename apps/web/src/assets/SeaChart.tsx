/**
 * A treasure chart for the empty state.
 *
 * Original drawing: a coastline, a reef, a marked route with a dashed leg, an anchorage and depth
 * soundings around an unnamed island. There is deliberately **no** X, no bounty figure and no
 * claim about what is inside — the chart says "nothing is here yet", which is exactly what the
 * surrounding sentence says in words.
 */
export function SeaChart({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`seachart ${className}`.trim()}
      viewBox="0 0 320 200"
      aria-hidden="true"
      focusable="false"
    >
      <g className="seachart__rule" stroke="currentColor" fill="none">
        <path d="M8 190h304" strokeWidth="2" />
        <path d="M8 186h304" strokeWidth="0.7" opacity="0.6" />
      </g>

      {/* island with a beach ring and two hills */}
      <g className="seachart__land" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M150 150c-26-6-46-24-42-46s30-40 58-40c30 0 54 18 56 40 2 20-16 40-44 46z" />
        <path
          d="M150 158c-34-6-60-28-56-56s36-50 70-50c36 0 66 22 68 50 2 26-22 50-58 56z"
          opacity="0.45"
          strokeDasharray="5 6"
        />
        <path d="M140 108l16-24 18 24z" strokeWidth="1.2" />
        <path d="M172 112l12-18 14 18z" strokeWidth="1.2" />
      </g>

      {/* reef marks */}
      <g className="seachart__reef" stroke="currentColor" strokeWidth="1.2" fill="none">
        <path d="M52 92c8-6 16-6 24 0M60 78c8-6 16-6 24 0" />
        <path d="M246 118c9-6 18-6 27 0M252 132c9-6 18-6 27 0" />
      </g>

      {/* marked route: a solid leg, then a dashed leg, then the anchorage */}
      <g className="seachart__route" fill="none">
        <path d="M20 168 84 150 118 120" strokeWidth="2" strokeDasharray="9 5" />
        <path className="seachart__route-live" d="M118 120 150 96" strokeWidth="2.4" />
      </g>
      <g className="seachart__mark" fill="currentColor">
        <circle cx="20" cy="168" r="3.4" />
        <circle cx="150" cy="96" r="3.2" />
      </g>

      {/* compass hint */}
      <g className="seachart__compass" fill="none" stroke="currentColor" strokeWidth="1.2">
        <circle cx="278" cy="42" r="18" />
        <path className="seachart__compass-needle" d="M278 24l5 18-5 36-5-36z" />
      </g>

      <g
        className="seachart__sounds"
        fill="currentColor"
        fontFamily="var(--font-mono)"
        fontSize="9"
      >
        <text x="66" y="132">
          18
        </text>
        <text x="228" y="76">
          24
        </text>
        <text x="196" y="176">
          6
        </text>
        <text x="104" y="60">
          31
        </text>
      </g>
    </svg>
  );
}
