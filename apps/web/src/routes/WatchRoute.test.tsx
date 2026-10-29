/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { WatchRoute } from './WatchRoute.js';

/**
 * The watch screen.
 *
 * A watch link is public and carries a delivery URL, so the rules that matter here are: a valid
 * HTTP(S) source produces a real player, a non-HTTP scheme is refused before it reaches a media
 * element, and the download control asks the delivery route for an attachment rather than another
 * playback tab.
 */

const SOURCE = 'https://api.opendrive.test/cdn/file_000/sobj_000?token=abc.def';

function renderWatch(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/watch?${search}`]}>
      <WatchRoute />
    </MemoryRouter>,
  );
}

describe('watch screen', () => {
  it('renders the player for an HTTP delivery URL and names the file', () => {
    renderWatch(new URLSearchParams({ src: SOURCE, title: 'clip.mp4', mpegts: '0' }).toString());

    expect(screen.getByRole('region', { name: 'Video player: clip.mp4' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Seek' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download video' }).getAttribute('href')).toBe(
      `${SOURCE}&download=1`,
    );
  });

  it('refuses a source that is not HTTP(S) before pointing a media element at it', () => {
    renderWatch(
      new URLSearchParams({ src: 'javascript:alert(1)', title: 'not-a-video' }).toString(),
    );

    expect(screen.getByText('Nothing to play')).toBeTruthy();
    expect(document.querySelector('video')).toBeNull();
  });

  it('refuses a source with embedded credentials', () => {
    renderWatch(new URLSearchParams({ src: 'https://user:pass@example.test/clip.mp4' }).toString());

    expect(screen.getByText('Nothing to play')).toBeTruthy();
    expect(document.querySelector('video')).toBeNull();
  });
});
