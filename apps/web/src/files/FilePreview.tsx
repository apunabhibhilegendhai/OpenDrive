import { useEffect, useState } from 'react';
import type { FileRecord } from '@opendrive/shared';
import { Icon } from '../components/Icon.js';
import type { ApiClient } from '../lib/api/client.js';
import { describeFailure } from '../lib/api/errors.js';
import { familyOf } from '../lib/files/kind.js';

/**
 * Inline preview for one file.
 *
 * The API serves an inline body only for a raster image, audio or video (see the server's
 * `isInlinePreviewable` allow-list; `image/svg+xml` is deliberately excluded because it is also a
 * scriptable document). For those, this asks the API for a short-lived grant and points the native
 * `<img>`/`<video>`/`<audio>` element at the signed URL: the element streams and seeks through the
 * file directly, so a multi-gigabyte video is never buffered in memory here. Text and code are read
 * through the authenticated client and shown as text, capped so a huge log cannot freeze the tab.
 * Everything else states plainly that there is no inline preview rather than pretending.
 *
 * The server is the authority on what is previewable: a `409` (the type is not rendered inline) or
 * a `503` (no signing secret configured) both land in the same honest "not available" state.
 */

type PreviewState =
  | { status: 'loading' }
  | { status: 'image' | 'video' | 'audio'; url: string }
  | { status: 'text'; body: string }
  | { status: 'unavailable'; detail: string };

/** Only read a text file into the tab when it is small enough to be text and not a data dump. */
const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

export function FilePreview({ api, file }: { api: ApiClient; file: FileRecord }) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: 'loading' });

    void (async () => {
      try {
        const family = familyOf(file.mimeType);
        if (family === 'image' || family === 'video' || family === 'audio') {
          const grant = await api.createPreview(file.id, controller.signal);
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
        <video className="preview__video" src={state.url} controls playsInline preload="metadata" />
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

      {(state.status === 'image' || state.status === 'video' || state.status === 'audio') && (
        <a className="preview__open" href={state.url} target="_blank" rel="noreferrer noopener">
          Open in a new tab
        </a>
      )}
    </section>
  );
}
