/**
 * Hand-drawn wave bands.
 *
 * Three overlapping wave lines of different amplitude and weight, the way ink would be laid down
 * by hand rather than by a plotting library. Used as a section divider, along the top edge of the
 * sign-in hero, and in empty states.
 *
 * Purely decorative: the element is `aria-hidden` because every wave in this product sits beside
 * a sentence that says the same thing in words.
 */
export function WaveBand({
  height = 26,
  flip = false,
  className = '',
}: {
  height?: number;
  flip?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={`waves ${className}`.trim()}
      viewBox="0 0 240 26"
      preserveAspectRatio="none"
      style={{ height, transform: flip ? 'scaleY(-1)' : undefined }}
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="waves__crest"
        d="M0 14c10-9 20-9 30 0s20 9 30 0 20-9 30 0 20 9 30 0 20-9 30 0 20 9 30 0 20-9 30 0 20 9 30 0"
        fill="none"
        strokeWidth="2.4"
      />
      <path
        className="waves__mid"
        d="M0 19c12-6 18-6 30 0s18 6 30 0 18-6 30 0 18 6 30 0 18-6 30 0 18 6 30 0 18-6 30 0 18 6 30 0"
        fill="none"
        strokeWidth="1.4"
      />
      <path
        className="waves__foam"
        d="M0 8c8-5 16-5 24 0M36 6c6-4 12-4 18 0M72 9c7-5 14-5 21 0M114 6c9-6 18-6 27 0M162 9c6-4 12-4 18 0M198 6c8-5 16-5 24 0"
        fill="none"
        strokeWidth="1.2"
      />
    </svg>
  );
}
