/**
 * The compass rose: OpenDrive's one piece of drawn identity.
 *
 * Original artwork (no external file, no request) in three sizes of ambition:
 *
 *   * `mark`    — the brand stamp in the rail and on the sign-in card.
 *   * `hero`    — a large rose for the sign-in screen, with the bearing letters.
 *   * `watermark` — a faint chart ornament laid behind a page header.
 *
 * Everything is drawn in `currentColor` except the single flag accent on the needle's north
 * point, and `bearing` rotates that needle, so the same drawing can report a real direction
 * instead of being purely decorative.
 */
export type CompassVariant = 'mark' | 'hero' | 'watermark';

export function CompassRose({
  size = 32,
  variant = 'mark',
  bearing = 45,
  title = 'OpenDrive',
}: {
  size?: number;
  variant?: CompassVariant;
  /** Degrees clockwise from north. Only the needle moves. */
  bearing?: number;
  /** Accessible name; pass null to mark the drawing decorative. */
  title?: string | null;
}) {
  const decorative = title === null;
  const detailed = variant !== 'mark';
  const ticks = Array.from({ length: 32 }, (_, index) => index * 11.25);
  const letters = [
    { text: 'N', x: 50, y: 12.5 },
    { text: 'E', x: 87.5, y: 53 },
    { text: 'S', x: 50, y: 93 },
    { text: 'W', x: 12.5, y: 53 },
  ];

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`rose rose--${variant}`}
      {...(decorative
        ? { 'aria-hidden': true, focusable: 'false' }
        : { role: 'img', 'aria-label': title })}
    >
      {/* outer ring, drawn twice to read as engraved */}
      <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <circle
        cx="50"
        cy="50"
        r="42"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.8"
        opacity="0.6"
      />
      <circle
        cx="50"
        cy="50"
        r="33"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.8"
        opacity="0.45"
      />

      {detailed && (
        <g stroke="currentColor" strokeWidth="1.1" opacity="0.75">
          {ticks.map((degrees) => (
            <line
              key={degrees}
              x1="50"
              y1="4"
              x2="50"
              y2={degrees % 45 === 0 ? '12' : '8.5'}
              transform={`rotate(${degrees} 50 50)`}
            />
          ))}
        </g>
      )}

      {/* eight major rays: two long, two medium, four short */}
      <g fill="currentColor" opacity="0.9">
        <path d="M50 8 56 50 50 92 44 50z" />
        <path d="M8 50 50 44 92 50 50 56z" />
      </g>
      <g fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.7">
        <path d="M22 22 50 50 78 78M78 22 50 50 22 78" />
      </g>

      {detailed && (
        <g
          className="rose__letters"
          fill="currentColor"
          fontFamily="var(--font-display)"
          fontSize="11"
          fontWeight="600"
          textAnchor="middle"
        >
          {letters.map((letter) => (
            <text key={letter.text} x={letter.x} y={letter.y}>
              {letter.text}
            </text>
          ))}
        </g>
      )}

      {/* the needle: the only place the flag accent appears */}
      <g transform={`rotate(${bearing} 50 50)`}>
        <path className="rose__needle" d="M50 18 56.5 50 50 60 43.5 50z" />
        <path d="M50 82 44.5 50 50 42 55.5 50z" fill="currentColor" opacity="0.55" />
      </g>
      <circle cx="50" cy="50" r="3.2" fill="currentColor" />
      <circle cx="50" cy="50" r="1.2" fill="var(--paper)" />
    </svg>
  );
}
