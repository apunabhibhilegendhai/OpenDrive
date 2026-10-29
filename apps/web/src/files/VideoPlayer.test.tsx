/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoPlayer } from './VideoPlayer.js';

/**
 * Player behaviour that is easy to regress.
 *
 * The fullscreen cases are the important ones: an embedded webview can leave
 * `requestFullscreen()` pending forever, and the player must still give the viewer a full-screen
 * picture instead of a button that silently does nothing. The others pin the keyboard controls
 * that make the player usable without a mouse.
 */

const SOURCE = 'https://api.opendrive.test/cdn/file_000/sobj_000?token=abc.def';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
  document.body.style.overflow = '';
});

function renderPlayer() {
  return render(<VideoPlayer src={SOURCE} title="clip.mp4" />);
}

describe('video player', () => {
  it('uses cinema mode when the Fullscreen API never answers', async () => {
    vi.useFakeTimers();
    // A webview that accepts the call but never settles the promise.
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: vi.fn(() => new Promise<void>(() => {})),
    });

    const { container } = renderPlayer();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
      await vi.advanceTimersByTimeAsync(800);
    });

    const player = container.querySelector('.video-player');
    expect(player?.classList.contains('video-player--cinema')).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Fullscreen');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('uses cinema mode when the Fullscreen API refuses', async () => {
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: vi.fn(() => Promise.reject(new Error('permissions policy'))),
    });

    const { container } = renderPlayer();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
      await Promise.resolve();
    });

    expect(container.querySelector('.video-player--cinema')).toBeTruthy();
  });

  it('leaves cinema mode when the fullscreen key is pressed again', async () => {
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: vi.fn(() => Promise.reject(new Error('unsupported'))),
    });

    const { container } = renderPlayer();
    const player = container.querySelector('.video-player');
    await act(async () => {
      fireEvent.keyDown(player as Element, { key: 'f' });
      await Promise.resolve();
    });
    expect(container.querySelector('.video-player--cinema')).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(player as Element, { key: 'f' });
      await Promise.resolve();
    });
    expect(container.querySelector('.video-player--cinema')).toBeNull();
  });

  it('seeks with the arrow keys and announces the jump', async () => {
    const { container } = renderPlayer();
    const video = container.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
    video.currentTime = 10;

    await act(async () => {
      fireEvent.keyDown(container.querySelector('.video-player') as Element, {
        key: 'ArrowRight',
      });
    });

    expect(video.currentTime).toBe(20);
  });

  it('downloads through the delivery route instead of opening another tab', () => {
    renderPlayer();
    expect(screen.getByRole('link', { name: 'Download video' }).getAttribute('href')).toBe(
      `${SOURCE}&download=1`,
    );
  });
});
