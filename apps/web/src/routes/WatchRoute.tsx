import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState } from '../files/EmptyState.js';
import { VideoPlayer } from '../files/VideoPlayer.js';

/**
 * The standalone watch screen.
 *
 * "Open in a new tab" must never point a tab straight at raw media. A top-level media response
 * makes the browser synthesize a document around the bytes, and MPEG-TS has no native decoder at
 * all, so a direct URL either shows "Unable to play media" or downloads a file nobody asked to
 * download. This route renders the same player the inspector uses instead.
 *
 * The `src` is a short-lived delivery URL, not a file id: the page stays usable without a session
 * (a delivery URL is its own credential) and without asking the API to re-authorize a file the
 * visitor may not own. Only HTTP(S) URLs are accepted, and credentials embedded in the URL are
 * rejected, so the query string cannot smuggle in another scheme.
 */

const TITLE_LIMIT = 200;

function readMediaUrl(value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url.href;
  } catch {
    return null;
  }
}

export function WatchRoute() {
  const [params] = useSearchParams();
  const src = readMediaUrl(params.get('src'));
  const title = params.get('title')?.trim().slice(0, TITLE_LIMIT) || null;
  const isMpegTs = params.get('mpegts') === '1' || params.get('mpegts') === 'true';

  useEffect(() => {
    const previous = document.title;
    document.title = title === null ? 'Watch · OpenDrive' : `${title} · OpenDrive`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  if (src === null) {
    return (
      <main className="watch watch--empty">
        <EmptyState
          kind="empty"
          title="Nothing to play"
          detail="This watch link has no playable source. Open the file from your drive and choose “Open in a new tab” again."
          action={
            <a className="btn" href="/drive">
              Go to My Drive
            </a>
          }
        />
      </main>
    );
  }

  return (
    <main className="watch">
      <header className="watch__bar">
        <a className="watch__brand" href="/">
          OpenDrive
        </a>
        <p className="watch__title" title={title ?? undefined}>
          {title ?? 'Video'}
        </p>
        <a className="watch__back" href="/drive">
          My Drive
        </a>
      </header>

      <div className="watch__stage">
        <VideoPlayer
          src={src}
          isMpegTs={isMpegTs}
          title={title ?? undefined}
          downloadName={title ?? undefined}
        />
      </div>

      <p className="watch__hint">
        <kbd>Space</kbd> play · <kbd>←</kbd>/<kbd>→</kbd> 10 seconds · <kbd>m</kbd> mute ·{' '}
        <kbd>f</kbd> fullscreen · <kbd>i</kbd> picture-in-picture
      </p>
    </main>
  );
}
