/**
 * File-type vocabulary.
 *
 * A file's family drives its glyph and its accent token, so a folder of screenshots looks
 * different from a folder of archives at a glance. The mapping is derived from the MIME type
 * the API returns; it never invents metadata the server did not supply.
 */
export type FileFamily =
  'image' | 'video' | 'audio' | 'document' | 'pdf' | 'archive' | 'code' | 'text' | 'other';

export interface FamilyStyle {
  family: FileFamily;
  label: string;
  /** CSS custom property name used as the tile accent. */
  token: string;
}

const STYLES: Record<FileFamily, FamilyStyle> = {
  image: { family: 'image', label: 'Image', token: '--teal' },
  video: { family: 'video', label: 'Video', token: '--primary' },
  audio: { family: 'audio', label: 'Audio', token: '--gold' },
  document: { family: 'document', label: 'Document', token: '--teal' },
  pdf: { family: 'pdf', label: 'PDF', token: '--danger' },
  archive: { family: 'archive', label: 'Archive', token: '--gold' },
  code: { family: 'code', label: 'Code', token: '--ok' },
  text: { family: 'text', label: 'Text', token: '--ink-soft' },
  other: { family: 'other', label: 'File', token: '--muted' },
};

export function familyOf(mimeType: string): FileFamily {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (
    mime === 'application/zip' ||
    mime === 'application/x-tar' ||
    mime === 'application/gzip' ||
    mime.includes('compressed') ||
    mime.includes('archive')
  ) {
    return 'archive';
  }
  if (
    mime.startsWith('text/') &&
    (mime.includes('javascript') ||
      mime.includes('typescript') ||
      mime.includes('html') ||
      mime.includes('css') ||
      mime.includes('xml'))
  ) {
    return 'code';
  }
  if (
    mime === 'application/json' ||
    mime === 'application/javascript' ||
    mime === 'application/typescript' ||
    mime === 'application/xml'
  ) {
    return 'code';
  }
  if (mime.startsWith('text/')) return 'text';
  if (
    mime.startsWith('application/vnd.openxmlformats') ||
    mime.startsWith('application/vnd.oasis') ||
    mime === 'application/msword' ||
    mime === 'application/rtf'
  ) {
    return 'document';
  }
  return 'other';
}

export function styleForMime(mimeType: string): FamilyStyle {
  return STYLES[familyOf(mimeType)];
}
