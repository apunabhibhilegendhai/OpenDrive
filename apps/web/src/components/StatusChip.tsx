export type StatusTone = 'live' | 'warn' | 'down' | 'idle';

const GLYPH: Record<StatusTone, string> = {
  live: '●',
  warn: '▲',
  down: '■',
  idle: '○',
};

/**
 * Status indicator.
 *
 * Carries three redundant signals — glyph shape, colour and the state word — so the
 * state survives greyscale printing and colour-vision differences, not just a coloured dot.
 */
export function StatusChip({
  tone,
  state,
  label,
}: {
  tone: StatusTone;
  state: string;
  label?: string;
}) {
  return (
    <span className={`chip chip--${tone}`}>
      <span className="chip__glyph" aria-hidden="true">
        {GLYPH[tone]}
      </span>
      <span className="chip__state">{state}</span>
      {label !== undefined && <span className="chip__label">{label}</span>}
    </span>
  );
}
