import { useCallback, useEffect, useRef, useState } from 'react';
import type { Player } from 'mpegts.js';
import { Icon } from '../components/Icon.js';

/** One alternate rendition offered by the API for this file. */
export interface VideoSource {
  label: string;
  url: string;
}

export interface VideoPlayerProps {
  src: string;
  isMpegTs?: boolean;
  title?: string;
  sources?: readonly VideoSource[];
  downloadName?: string;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const CONTROLS_HIDE_DELAY_MS = 2800;
const STALL_NUDGE_DELAY_MS = 10_000;
const FULLSCREEN_SETTLE_TIMEOUT_MS = 700;

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  msRequestFullscreen?: () => Promise<void> | void;
};

/**
 * Safari exposes its own fullscreen entry point on the media element, and the DOM lib does not
 * declare it. The methods are optional: every other browser leaves them undefined.
 */
declare global {
  interface HTMLVideoElement {
    webkitEnterFullscreen?: () => void;
    webkitExitFullscreen?: () => void;
    webkitDisplayingFullscreen?: boolean;
  }
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  msExitFullscreen?: () => Promise<void> | void;
};

/**
 * `mpegts.js` declares a player in its bundled namespace but the installed declaration the web
 * build resolves does not expose `on`; the runtime object does. Keep the extra method optional so
 * the call is safe on either shape.
 */
type MpegtsPlayer = Player & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function percentOf(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return clamp((value / total) * 100, 0, 100);
}

/**
 * Resolve `true` when a fullscreen request settles, `false` when it refuses or never answers.
 *
 * A browser is allowed to leave `requestFullscreen()` pending indefinitely — embedded webviews and
 * some permission policies do exactly that — and an `await` on it would then strand the button with
 * no feedback. The timeout is what guarantees the caller can fall back to the CSS cinema mode.
 * A request that resolves *after* the timeout is still harmless: the `fullscreenchange` listener
 * switches the player out of cinema mode once the real fullscreen element appears.
 */
function settlesWithin(request: Promise<void> | void, milliseconds: number): Promise<boolean> {
  if (request === undefined) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (entered: boolean) => {
      if (done) return;
      done = true;
      resolve(entered);
    };
    const timer = setTimeout(() => finish(false), milliseconds);
    request.then(
      () => {
        clearTimeout(timer);
        finish(true);
      },
      () => {
        clearTimeout(timer);
        finish(false);
      },
    );
  });
}

/**
 * Append the delivery route's explicit download flag.
 *
 * A delivery URL serves video inline so a `<video>` can stream it; the same URL with
 * `download=1` answers `Content-Disposition: attachment`. That makes the control bar's download
 * action a real download instead of a second playback tab, including for a cross-origin URL where
 * the HTML `download` attribute would otherwise be ignored.
 */
function downloadUrlFor(src: string): string {
  try {
    const url = new URL(src, window.location.origin);
    url.searchParams.set('download', '1');
    return url.href;
  } catch {
    return src;
  }
}

/**
 * The video player.
 *
 * Native `<video>` does the decoding (and `mpegts.js` handles MPEG-TS, which browsers cannot play
 * natively), but the controls are ours: a buffered/played track, keyboard shortcuts, playback
 * speed, picture-in-picture, a fallback "cinema" mode, and a real download link.
 *
 * Fullscreen is requested on the whole container, not the element, so the controls stay visible.
 * Every prefixed entry point is tried before falling back to the iOS native player, and a CSS
 * cinema mode covers a browser that rejects the Fullscreen API entirely. The controls auto-hide
 * while playing and return on pointer movement or keyboard focus.
 */
export function VideoPlayer({
  src,
  isMpegTs = false,
  title,
  sources = [],
  downloadName,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastVolume = useRef(1);

  const [activeSrc, setActiveSrc] = useState(src);
  const [activeQuality, setActiveQuality] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cinema, setCinema] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const pipSupported =
    typeof document !== 'undefined' &&
    'pictureInPictureEnabled' in document &&
    document.pictureInPictureEnabled === true;

  const progressPercent = percentOf(currentTime, duration);
  const bufferedPercent = percentOf(buffered, duration);
  const effectiveVolume = muted ? 0 : volume;
  const showBigPlay = !playing && !buffering && !failed;
  const downloadHref = downloadUrlFor(activeSrc);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const wakeControls = useCallback(() => {
    setControlsVisible(true);
    clearHideTimer();
    if (playing && !settingsOpen && !failed) {
      hideTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_DELAY_MS);
    }
  }, [clearHideTimer, failed, playing, settingsOpen]);

  useEffect(() => {
    wakeControls();
    return clearHideTimer;
  }, [clearHideTimer, wakeControls]);

  useEffect(
    () => () => {
      clearHideTimer();
      if (stallTimer.current !== null) clearTimeout(stallTimer.current);
    },
    [clearHideTimer],
  );

  // A new source is a new media element: reset the readout so the previous clip's duration or
  // position never flashes over the new one.
  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setBuffered(0);
    setBuffering(false);
    setPlaying(false);
    setFailed(false);
    setAnnouncement('');
  }, [activeSrc, reloadToken]);

  // MPEG-TS has no native browser decoder; mpegts.js transmuxes it into MSE.
  useEffect(() => {
    if (!isMpegTs || videoRef.current === null) return;
    const element = videoRef.current;
    let player: MpegtsPlayer | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const mpegts = (await import('mpegts.js')).default;
        if (cancelled) return;
        if (!mpegts.isSupported()) {
          setFailed(true);
          setBuffering(false);
          return;
        }
        const created = mpegts.createPlayer(
          { type: 'mpegts', isLive: false, url: activeSrc, cors: true },
          { enableWorker: false },
        ) as MpegtsPlayer;
        if (cancelled) {
          created.destroy();
          return;
        }
        player = created;
        created.on?.('error', () => {
          if (cancelled) return;
          setFailed(true);
          setBuffering(false);
        });
        created.attachMediaElement(element);
        created.load();
      } catch {
        if (!cancelled) {
          setFailed(true);
          setBuffering(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      player?.destroy();
    };
  }, [activeSrc, isMpegTs, reloadToken]);

  // Re-apply the chosen volume, mute and speed after a source switch remounts the element.
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    video.volume = volume;
    video.muted = muted;
    video.playbackRate = rate;
  }, [activeSrc, muted, rate, volume]);

  // Fullscreen can be entered or left through the browser's own UI or Escape; track that rather
  // than assuming our own button was the last actor.
  useEffect(() => {
    const onChange = () => {
      const doc = document as FullscreenDocument;
      const active =
        doc.fullscreenElement ?? doc.webkitFullscreenElement ?? doc.msFullscreenElement ?? null;
      if (active === containerRef.current) {
        setIsFullscreen(true);
        setCinema(false);
        setControlsVisible(true);
      } else if (active === null) {
        setIsFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    document.addEventListener('msfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
      document.removeEventListener('msfullscreenchange', onChange);
    };
  }, []);

  // A browser without the Fullscreen API gets a full-viewport "cinema" mode instead.
  useEffect(() => {
    if (!cinema) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCinema(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [cinema]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && settingsRef.current?.contains(target) === true) return;
      setSettingsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [settingsOpen]);

  // Picture-in-picture can be closed from its own floating window.
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    const enter = () => setPipActive(true);
    const leave = () => setPipActive(false);
    video.addEventListener('enterpictureinpicture', enter);
    video.addEventListener('leavepictureinpicture', leave);
    return () => {
      video.removeEventListener('enterpictureinpicture', enter);
      video.removeEventListener('leavepictureinpicture', leave);
    };
  }, [activeSrc]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;
    if (video.paused) {
      const result = video.play();
      if (result !== undefined) {
        void result.catch(() => {
          // Autoplay policy or a dead URL: the error event (or retry panel) says so.
        });
      }
      setAnnouncement('Playing');
    } else {
      video.pause();
      setAnnouncement('Paused');
    }
  }, []);

  const seekTo = useCallback((value: number) => {
    const video = videoRef.current;
    if (video === null) return;
    const target = clamp(value, 0, Number.isFinite(video.duration) ? video.duration : value);
    video.currentTime = target;
    setCurrentTime(target);
  }, []);

  const skip = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (video === null) return;
      seekTo(video.currentTime + seconds);
      wakeControls();
    },
    [seekTo, wakeControls],
  );

  const changeVolume = useCallback((next: number) => {
    const value = clamp(next, 0, 1);
    const video = videoRef.current;
    setVolume(value);
    setMuted(value === 0);
    if (value > 0) lastVolume.current = value;
    if (video !== null) {
      video.volume = value;
      video.muted = value === 0;
    }
    setAnnouncement(value === 0 ? 'Muted' : `Volume ${Math.round(value * 100)}%`);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;
    if (muted || volume === 0) {
      const restored = lastVolume.current > 0 ? lastVolume.current : 1;
      setVolume(restored);
      setMuted(false);
      video.volume = restored;
      video.muted = false;
      setAnnouncement(`Volume ${Math.round(restored * 100)}%`);
    } else {
      lastVolume.current = volume;
      setMuted(true);
      video.muted = true;
      setAnnouncement('Muted');
    }
  }, [muted, volume]);

  const changeRate = useCallback((next: number) => {
    setRate(next);
    setAnnouncement(`Playback speed ${next}×`);
  }, []);

  const chooseSource = useCallback(
    (source: VideoSource | null) => {
      setActiveSrc(source?.url ?? src);
      setActiveQuality(source?.label ?? null);
      setSettingsOpen(false);
      setAnnouncement(source === null ? 'Automatic quality' : `Quality ${source.label}`);
    },
    [src],
  );

  const enterCinema = useCallback(() => {
    setCinema(true);
    setControlsVisible(true);
    setAnnouncement('Fullscreen');
  }, []);

  const exitFullscreen = useCallback(async () => {
    const video = videoRef.current;
    if (video?.webkitDisplayingFullscreen === true) {
      video.webkitExitFullscreen?.();
      return;
    }
    const doc = document as FullscreenDocument;
    try {
      if (doc.exitFullscreen !== undefined) {
        await doc.exitFullscreen();
      } else if (doc.webkitExitFullscreen !== undefined) {
        await doc.webkitExitFullscreen();
      } else if (doc.msExitFullscreen !== undefined) {
        await doc.msExitFullscreen();
      }
    } catch {
      setCinema(false);
    }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen) {
      await exitFullscreen();
      return;
    }
    if (cinema) {
      setCinema(false);
      return;
    }
    const container = containerRef.current as FullscreenElement | null;
    if (container !== null) {
      // Bound the wait: an embedded webview may never settle the promise, and the cinema
      // fallback below is only reachable once this attempt has clearly failed.
      const entered =
        container.requestFullscreen !== undefined
          ? await settlesWithin(container.requestFullscreen(), FULLSCREEN_SETTLE_TIMEOUT_MS)
          : container.webkitRequestFullscreen !== undefined
            ? await settlesWithin(container.webkitRequestFullscreen(), FULLSCREEN_SETTLE_TIMEOUT_MS)
            : container.msRequestFullscreen !== undefined
              ? await settlesWithin(container.msRequestFullscreen(), FULLSCREEN_SETTLE_TIMEOUT_MS)
              : false;
      if (entered) {
        setAnnouncement('Fullscreen');
        return;
      }
    }
    const video = videoRef.current;
    if (video?.webkitEnterFullscreen !== undefined) {
      try {
        video.webkitEnterFullscreen();
        setAnnouncement('Fullscreen');
        return;
      } catch {
        // Fall through to the CSS fallback.
      }
    }
    enterCinema();
  }, [cinema, enterCinema, exitFullscreen, isFullscreen]);

  const togglePip = useCallback(async () => {
    const video = videoRef.current;
    if (video === null || !pipSupported) return;
    try {
      if (document.pictureInPictureElement !== null) {
        await document.exitPictureInPicture();
        setAnnouncement('Picture-in-picture closed');
      } else {
        await video.requestPictureInPicture();
        setAnnouncement('Picture-in-picture');
      }
    } catch {
      setAnnouncement('Picture-in-picture is not available');
    }
  }, [pipSupported]);

  const retry = useCallback(() => {
    setFailed(false);
    setBuffering(true);
    setReloadToken((value) => value + 1);
    const video = videoRef.current;
    if (video !== null && !isMpegTs) video.load();
  }, [isMpegTs]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const onButton = tag === 'BUTTON' || tag === 'A';
    const key = event.key.toLowerCase();

    if ((event.key === ' ' || event.key === 'Spacebar') && !onButton) {
      event.preventDefault();
      togglePlay();
      wakeControls();
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      seekTo(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      seekTo(duration);
      return;
    }

    switch (key) {
      case 'k':
        event.preventDefault();
        togglePlay();
        wakeControls();
        break;
      case 'j':
        event.preventDefault();
        skip(-10);
        break;
      case 'l':
        event.preventDefault();
        skip(10);
        break;
      case 'arrowleft':
        event.preventDefault();
        skip(-10);
        break;
      case 'arrowright':
        event.preventDefault();
        skip(10);
        break;
      case 'arrowup':
        event.preventDefault();
        changeVolume(effectiveVolume + 0.1);
        wakeControls();
        break;
      case 'arrowdown':
        event.preventDefault();
        changeVolume(effectiveVolume - 0.1);
        wakeControls();
        break;
      case 'm':
        event.preventDefault();
        toggleMute();
        wakeControls();
        break;
      case 'f':
        event.preventDefault();
        void toggleFullscreen();
        break;
      case 'i':
      case 'p':
        event.preventDefault();
        void togglePip();
        break;
      default:
        if (/^[0-9]$/.test(key) && duration > 0) {
          event.preventDefault();
          seekTo((Number(key) / 10) * duration);
        }
    }
  };

  const onProgress = () => {
    const video = videoRef.current;
    if (video === null || video.buffered.length === 0) return;
    setBuffered(video.buffered.end(video.buffered.length - 1));
  };

  const onWaiting = () => {
    setBuffering(true);
    if (stallTimer.current !== null) clearTimeout(stallTimer.current);
    if (isMpegTs) return;
    stallTimer.current = setTimeout(() => {
      const video = videoRef.current;
      if (video === null) return;
      const position = video.currentTime;
      video.load();
      const onReady = () => {
        video.currentTime = position;
        video.removeEventListener('canplay', onReady);
      };
      video.addEventListener('canplay', onReady, { once: true });
    }, STALL_NUDGE_DELAY_MS);
  };

  const clearStall = () => {
    if (stallTimer.current !== null) {
      clearTimeout(stallTimer.current);
      stallTimer.current = null;
    }
  };

  const onLoadedMetadata = () => {
    const video = videoRef.current;
    if (video === null) return;
    const next = video.duration;
    setDuration(Number.isFinite(next) && next > 0 ? next : 0);
    onProgress();
  };

  const onVolumeChange = () => {
    const video = videoRef.current;
    if (video === null) return;
    setVolume(video.volume);
    setMuted(video.muted);
    if (!video.muted && video.volume > 0) lastVolume.current = video.volume;
  };

  return (
    <div
      ref={containerRef}
      className={[
        'video-player',
        cinema ? 'video-player--cinema' : '',
        controlsVisible ? 'video-player--awake' : 'video-player--asleep',
      ]
        .filter(Boolean)
        .join(' ')}
      role="region"
      aria-label={title === undefined ? 'Video player' : `Video player: ${title}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerMove={wakeControls}
      onPointerLeave={() => {
        if (playing && !settingsOpen) setControlsVisible(false);
      }}
      onFocusCapture={() => setControlsVisible(true)}
    >
      <video
        key={activeSrc}
        ref={videoRef}
        className="video-player__media"
        src={isMpegTs ? undefined : activeSrc}
        playsInline
        preload="metadata"
        aria-label={title ?? 'Video'}
        onClick={() => {
          containerRef.current?.focus({ preventScroll: true });
          togglePlay();
          wakeControls();
        }}
        onDoubleClick={() => void toggleFullscreen()}
        onPlay={() => {
          setPlaying(true);
          setBuffering(false);
          clearStall();
          wakeControls();
        }}
        onPause={() => {
          setPlaying(false);
          setControlsVisible(true);
          clearHideTimer();
        }}
        onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
        onDurationChange={onLoadedMetadata}
        onLoadedMetadata={onLoadedMetadata}
        onProgress={onProgress}
        onWaiting={onWaiting}
        onCanPlay={() => {
          setBuffering(false);
          clearStall();
        }}
        onPlaying={() => {
          setBuffering(false);
          clearStall();
        }}
        onVolumeChange={onVolumeChange}
        onRateChange={() => setRate(videoRef.current?.playbackRate ?? 1)}
        onError={() => {
          setFailed(true);
          setBuffering(false);
          clearStall();
        }}
      />

      {buffering && !failed && (
        <div className="video-player__spinner" role="status" aria-label="Buffering">
          <span className="video-player__spinner-ring" aria-hidden="true" />
        </div>
      )}

      {showBigPlay && (
        <button
          type="button"
          className="video-player__big-play"
          onClick={() => {
            togglePlay();
            wakeControls();
          }}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          <Icon name="play" size={32} />
        </button>
      )}

      {failed && (
        <div className="video-player__error" role="alert">
          <Icon name="alert" size={24} />
          <p className="video-player__error-title">This video could not be played.</p>
          <p className="video-player__error-note">
            The link may have expired, the format may be unsupported, or the browser could not reach
            the file.
          </p>
          <div className="video-player__error-actions">
            <button type="button" className="video-player__action" onClick={retry}>
              <Icon name="refresh" size={16} />
              Retry
            </button>
            <a className="video-player__action" href={downloadHref} download={downloadName}>
              <Icon name="download" size={16} />
              Download
            </a>
          </div>
        </div>
      )}

      {title !== undefined && (
        <div className="video-player__titlebar">
          <p className="video-player__title" title={title}>
            {title}
          </p>
        </div>
      )}

      <div className="video-player__controls">
        <div className="video-player__track-wrap">
          <div className="video-player__track" aria-hidden="true">
            <div
              className="video-player__track-buffered"
              style={{ width: `${bufferedPercent}%` }}
            />
            <div className="video-player__track-played" style={{ width: `${progressPercent}%` }} />
          </div>
          <input
            className="video-player__seek"
            type="range"
            min={0}
            max={duration > 0 ? duration : 0}
            step={0.1}
            value={Math.min(currentTime, duration > 0 ? duration : 0)}
            disabled={duration <= 0}
            onChange={(event) => seekTo(Number(event.target.value))}
            aria-label="Seek"
            aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
          />
        </div>

        <div className="video-player__row">
          <button
            type="button"
            className="video-player__button"
            onClick={() => {
              togglePlay();
              wakeControls();
            }}
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause (k)' : 'Play (k)'}
          >
            <Icon name={playing ? 'pause' : 'play'} size={18} />
          </button>
          <button
            type="button"
            className="video-player__button"
            onClick={() => skip(-10)}
            aria-label="Back 10 seconds"
            title="Back 10 seconds (←)"
          >
            <Icon name="rewind" size={18} />
          </button>
          <button
            type="button"
            className="video-player__button"
            onClick={() => skip(10)}
            aria-label="Forward 10 seconds"
            title="Forward 10 seconds (→)"
          >
            <Icon name="forward" size={18} />
          </button>

          <div className="video-player__volume">
            <button
              type="button"
              className="video-player__button"
              onClick={toggleMute}
              aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
              title={muted ? 'Unmute (m)' : 'Mute (m)'}
            >
              <Icon name={muted || volume === 0 ? 'volume-off' : 'volume'} size={18} />
            </button>
            <input
              className="video-player__volume-slider"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={effectiveVolume}
              onChange={(event) => changeVolume(Number(event.target.value))}
              aria-label="Volume"
              aria-valuetext={`${Math.round(effectiveVolume * 100)}%`}
            />
          </div>

          <span className="video-player__time">
            <span className="video-player__time-current">{formatTime(currentTime)}</span>
            <span aria-hidden="true"> / </span>
            <span className="video-player__time-total">{formatTime(duration)}</span>
          </span>

          <span className="video-player__spacer" />

          <div className="video-player__settings" ref={settingsRef}>
            <button
              type="button"
              className="video-player__button"
              onClick={() => {
                setSettingsOpen((open) => !open);
                setControlsVisible(true);
              }}
              aria-label="Playback settings"
              aria-expanded={settingsOpen}
              title="Playback settings"
            >
              <Icon name="settings" size={18} />
            </button>
            {settingsOpen && (
              <div className="video-player__panel" role="group" aria-label="Playback settings">
                <p className="video-player__panel-label">Speed</p>
                <div className="video-player__chips">
                  {PLAYBACK_RATES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={
                        value === rate
                          ? 'video-player__chip video-player__chip--active'
                          : 'video-player__chip'
                      }
                      aria-pressed={value === rate}
                      onClick={() => changeRate(value)}
                    >
                      {value}×
                    </button>
                  ))}
                </div>

                {sources.length > 0 && (
                  <>
                    <p className="video-player__panel-label">Quality</p>
                    <div className="video-player__chips">
                      <button
                        type="button"
                        className={
                          activeQuality === null
                            ? 'video-player__chip video-player__chip--active'
                            : 'video-player__chip'
                        }
                        aria-pressed={activeQuality === null}
                        onClick={() => chooseSource(null)}
                      >
                        Auto
                      </button>
                      {sources.map((source, index) => (
                        <button
                          key={`${source.label}-${index}`}
                          type="button"
                          className={
                            activeQuality === source.label
                              ? 'video-player__chip video-player__chip--active'
                              : 'video-player__chip'
                          }
                          aria-pressed={activeQuality === source.label}
                          onClick={() => chooseSource(source)}
                        >
                          {source.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {pipSupported && (
            <button
              type="button"
              className={
                pipActive
                  ? 'video-player__button video-player__button--active'
                  : 'video-player__button'
              }
              onClick={() => void togglePip()}
              aria-label={pipActive ? 'Exit picture-in-picture' : 'Picture-in-picture'}
              aria-pressed={pipActive}
              title="Picture-in-picture (i)"
            >
              <Icon name="pip" size={18} />
            </button>
          )}

          <a
            className="video-player__button"
            href={downloadHref}
            download={downloadName}
            aria-label="Download video"
            title="Download"
          >
            <Icon name="download" size={18} />
          </a>

          <button
            type="button"
            className="video-player__button"
            onClick={() => void toggleFullscreen()}
            aria-label={isFullscreen || cinema ? 'Exit fullscreen' : 'Fullscreen'}
            aria-pressed={isFullscreen || cinema}
            title={isFullscreen || cinema ? 'Exit fullscreen (f)' : 'Fullscreen (f)'}
          >
            <Icon name={isFullscreen || cinema ? 'exit-fullscreen' : 'fullscreen'} size={18} />
          </button>
        </div>
      </div>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
