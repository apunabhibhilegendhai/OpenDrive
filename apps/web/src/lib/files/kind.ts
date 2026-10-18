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

const EXTENSION_MIME: Record<string, string> = {
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  m2t: 'video/mp2t',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  '3gp': 'video/3gpp',
};

function guessMimeTypeFromFilename(filename: string): string {
  const extension = filename.toLowerCase().split('.').pop() ?? '';
  return EXTENSION_MIME[extension] ?? 'application/octet-stream';
}

function resolvedMime(mimeType: string, filename?: string): string {
  const mime = mimeType.toLowerCase();
  if (mime !== '' && mime !== 'application/octet-stream') return mime;
  if (filename !== undefined && filename !== '') return guessMimeTypeFromFilename(filename);
  return mime;
}

export function familyOf(mimeType: string, filename?: string): FileFamily {
  const mime = resolvedMime(mimeType, filename);
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

export function styleForMime(mimeType: string, filename?: string): FamilyStyle {
  return STYLES[familyOf(mimeType, filename)];
}
