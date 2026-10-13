/**
 * A printed-plate frame.
 *
 * Four printed corner marks, a deckled paper edge and an optional stamp slot — the framing a
 * "wanted poster" would have, without a single claim about the file inside it. Nothing here
 * labels a file as dangerous, public or valuable: the stamp text is whatever the caller passes,
 * and every stamp in this product quotes the API's own metadata.
 *
 * Drawn with CSS (see `.plate` in files.css) plus four small corner SVGs, so the frame scales with
 * its container instead of being a fixed-size image.
 */
export function PosterFrame({
  stamp,
  tone = 'plain',
  children,
}: {
  /** Short, factual stamp text — a file state, a date, never an invented score. */
  stamp?: string;
  tone?: 'plain' | 'ok' | 'warn' | 'danger' | 'accent';
  children: React.ReactNode;
}) {
  return (
    <div className={`plate plate--${tone}`}>
      <span className="plate__marks" aria-hidden="true">
        <svg viewBox="0 0 12 12" className="plate__mark plate__mark--tl" focusable="false">
          <path d="M0 4h1.5v-2.5H4V0H0z" fill="currentColor" />
        </svg>
        <svg viewBox="0 0 12 12" className="plate__mark plate__mark--tr" focusable="false">
          <path d="M0 4h1.5v-2.5H4V0H0z" fill="currentColor" />
        </svg>
        <svg viewBox="0 0 12 12" className="plate__mark plate__mark--bl" focusable="false">
          <path d="M0 4h1.5v-2.5H4V0H0z" fill="currentColor" />
        </svg>
        <svg viewBox="0 0 12 12" className="plate__mark plate__mark--br" focusable="false">
          <path d="M0 4h1.5v-2.5H4V0H0z" fill="currentColor" />
        </svg>
      </span>
      {/* The stamp repeats a fact the caller also states in its own text, so it is marked
          decorative: a screen reader should hear a file's state once, not twice. */}
      {stamp !== undefined && (
        <span className="plate__stamp" aria-hidden="true">
          {stamp}
        </span>
      )}
      <div className="plate__body">{children}</div>
    </div>
  );
}
