import { useEffect, useState } from 'react';
import type { FileRecord } from '@opendrive/shared';
import { Icon } from '../components/Icon.js';
import { API_BASE_URL, type ApiClient } from '../lib/api/client.js';
import { describeFailure } from '../lib/api/errors.js';
import { familyOf } from '../lib/files/kind.js';
import { VideoPlayer, type VideoSource } from './VideoPlayer.js';

/**
 * Inline preview for one file.
 *
 * The API serves an inline body only for a raster image, audio or video (see the server's
 * `isInlinePreviewable` allow-list; `image/svg+xml` is deliberately excluded because it is also a
 * scriptable document, and the delivery route answers it as an attachment). For those, this asks
 * the API for a short-lived **delivery** URL and points the native `<img>`/`<video>`/`<audio>`
 * element at it: the element streams and seeks through the file directly, so a multi-gigabyte video
 * is never buffered in memory here. A delivery URL is the cacheable surface — `public, immutable`,
 * keyed to the object version — so the browser and any proxy in front of the API can hold the bytes
 * and re-serve them, and a repeat seek does not touch storage again. Text and code are read through
 * the authenticated client and shown as text, capped so a huge log cannot freeze the tab.
 * Everything else states plainly that there is no inline preview rather than pretending.
 *
 * The server is the authority on what is previewable: a `409` (the file has no servable content) or
 * a `503` (no signing secret configured) both land in the same honest "not available" state.
 */

type PreviewState =
  | { status: 'loading' }
  | { status: 'image' | 'audio'; url: string }
  | { status: 'video'; url: string; sources: VideoSource[] }
  | { status: 'text'; body: string }
  | { status: 'unavailable'; detail: string };

/** Only read a text file into the tab when it is small enough to be text and not a data dump. */
const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

/**
 * Resolve a rendition URL the same way the API client resolves its base URL.
 *
 * The rendition route stores whatever URL a client registered, so it may be absolute or rooted at
 * the API origin. Only plain HTTP(S) sources are offered to the player; anything else (`javascript:`,
 * a data URL) is dropped rather than handed to a media element.
 */
function resolveMediaUrl(value: string): string | null {
  try {
    const base = API_BASE_URL === '' ? window.location.origin : API_BASE_URL;
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function FilePreview({ api, file }: { api: ApiClient; file: FileRecord }) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });

  const isMpegTs =
    file.mimeType === 'video/mp2t' ||
    file.mimeType === 'video/vnd.dlna.mpeg-tts' ||
    file.filename.toLowerCase().endsWith('.ts') ||
    file.filename.toLowerCase().endsWith('.m2ts') ||
    file.filename.toLowerCase().endsWith('.mts');

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: 'loading' });

    void (async () => {
      try {
        const family = familyOf(file.mimeType, file.filename);
        if (family === 'video') {
          // A video may also have alternate renditions. Asking for them is best-effort: a 404 or a
          // deployment that never registered one must not stop the original from playing.
          const [grant, renditions] = await Promise.all([
            api.createDeliveryUrl(file.id, controller.signal),
            api.listRenditions(file.id, controller.signal).catch(() => []),
          ]);
          if (!cancelled) {
            const sources: VideoSource[] = [];
            for (const rendition of renditions) {
              const url = resolveMediaUrl(rendition.url);
              if (url !== null && rendition.label.trim() !== '') {
                sources.push({ label: rendition.label, url });
              }
            }
            setState({ status: 'video', url: grant.url, sources });
          }
          return;
        }
        if (family === 'image' || family === 'audio') {
          const grant = await api.createDeliveryUrl(file.id, controller.signal);
          if (!cancelled) setState({ status: family, url: grant.url });
          return;
        }
        if ((family === 'text' || family === 'code') && file.sizeBytes <= TEXT_PREVIEW_MAX_BYTES) {
          const response = await api.openContent(file.id, { signal: controller.signal });
          const body = await response.text();
          if (!cancelled) setState({ status: 'text', body });
          return;
        }
        if (!cancelled) {
          setState({
            status: 'unavailable',
            detail:
              family === 'text' || family === 'code'
                ? 'This file is too large to show as text here. Download it to read it.'
                : 'This file type has no inline preview. Download it to open it.',
          });
        }
      } catch (failure) {
        if (cancelled) return;
        if (failure instanceof DOMException && failure.name === 'AbortError') return;
        setState({ status: 'unavailable', detail: describeFailure(failure) });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, file]);

  return (
    <section className="preview" aria-label={`Preview of ${file.filename}`}>
      {state.status === 'loading' && (
        <p className="preview__status">
          <Icon name="info" size={14} /> Preparing preview…
        </p>
      )}

      {state.status === 'image' && (
        <img className="preview__image" src={state.url} alt={file.filename} />
      )}
      {state.status === 'video' && (
        <VideoPlayer
          src={state.url}
          isMpegTs={isMpegTs}
          title={file.filename}
          sources={state.sources}
          downloadName={file.filename}
        />
      )}
      {state.status === 'audio' && (
        <audio className="preview__audio" src={state.url} controls preload="metadata" />
      )}
      {state.status === 'text' && <pre className="preview__text">{state.body}</pre>}

      {state.status === 'unavailable' && (
        <p className="preview__status">
          <Icon name="info" size={14} /> {state.detail}
        </p>
      )}

      {state.status === 'video' && (
        <a
          className="preview__open"
          href={`/watch?${new URLSearchParams({
            src: state.url,
            title: file.filename,
            ...(isMpegTs ? { mpegts: '1' } : {}),
          }).toString()}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open in a new tab
        </a>
      )}
      {(state.status === 'image' || state.status === 'audio') && (
        <a className="preview__open" href={state.url} target="_blank" rel="noreferrer noopener">
          Open in a new tab
        </a>
      )}
    </section>
  );
}
