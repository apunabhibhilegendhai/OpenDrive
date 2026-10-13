/**
 * The log pose: a dial that reports one transfer's real progress.
 *
 * A functional instrument, not an ornament. The needle's angle and the arc are both computed
 * from bytes the browser has actually handed to the socket, the number in the middle is that same
 * figure, and the caption is the phase word. Nothing here interpolates: if the API has not
 * answered, the dial does not move.
 *
 * The dial is `aria-hidden` because the row it sits in already carries a labelled progress bar;
 * a screen reader would otherwise hear the same number twice.
 */
export function LogPoseDial({
  progress,
  phase,
  size = 52,
}: {
  /** 0–1, from real transmitted bytes. */
  progress: number;
  phase: string;
  size?: number;
}) {
  const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const percent = Math.round(clamped * 100);
  const ticks = Array.from({ length: 24 }, (_, index) => index * 15);
  const circumference = 2 * Math.PI * 34;

  return (
    <span
      className={`dial dial--${phase}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" width={size} height={size} focusable="false">
        <circle
          cx="50"
          cy="50"
          r="44"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.85"
        />
        <g stroke="currentColor" strokeWidth="1" opacity="0.5">
          {ticks.map((degrees) => (
            <line
              key={degrees}
              x1="50"
              y1="7"
              x2="50"
              y2={degrees % 45 === 0 ? '13' : '10'}
              transform={`rotate(${degrees} 50 50)`}
            />
          ))}
        </g>
        {/* the travelled arc, drawn from north clockwise */}
        <circle
          className="dial__arc"
          cx="50"
          cy="50"
          r="34"
          fill="none"
          strokeWidth="6"
          strokeLinecap="butt"
          strokeDasharray={`${(circumference * clamped).toFixed(2)} ${circumference.toFixed(2)}`}
          transform="rotate(-90 50 50)"
        />
        <g transform={`rotate(${-135 + clamped * 270} 50 50)`}>
          <path className="dial__needle" d="M50 16 54 50 50 56 46 50z" />
        </g>
        <circle cx="50" cy="50" r="2.6" fill="currentColor" />
        <text
          className="dial__value"
          x="50"
          y="70"
          textAnchor="middle"
          fontFamily="var(--font-mono)"
          fontSize="17"
          fill="currentColor"
        >
          {percent}
        </text>
      </svg>
    </span>
  );
}
