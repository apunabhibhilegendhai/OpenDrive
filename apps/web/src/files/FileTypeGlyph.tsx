import { familyOf, styleForMime } from '../lib/files/kind.js';

const STAMPS: Record<string, string> = {
  image: 'IMG',
  video: 'VID',
  audio: 'AUD',
  document: 'DOC',
  pdf: 'PDF',
  archive: 'ZIP',
  code: 'SRC',
  text: 'TXT',
  other: 'BIN',
};

/**
 * A file's type as a printed stamp rather than a decorative icon: three letters in a ruled box,
 * coloured by family. It is decorative for screen readers — the type is stated in the row's
 * metadata — so it never becomes the only way to know what a file is.
 */
export function FileTypeGlyph({ mimeType, size = 34 }: { mimeType: string; size?: number }) {
  const style = styleForMime(mimeType);
  return (
    <span
      className="stamp"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.3)),
        color: `var(${style.token})`,
      }}
      aria-hidden="true"
    >
      {STAMPS[familyOf(mimeType)] ?? 'BIN'}
    </span>
  );
}
