import { useEffect, useRef, useState } from 'react';
import type { Player } from 'mpegts.js';
import { Icon } from '../components/Icon.js';

export function VideoPlayer({ src, isMpegTs }: { src: string; isMpegTs: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [bufferedPercent, setBufferedPercent] = useState(0);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (stallTimer.current !== null) clearTimeout(stallTimer.current);
  }, []);

  // MPEG-TS needs mpegts.js; everything else uses the native element.
  useEffect(() => {
    if (!isMpegTs || videoRef.current === null) return;
    const element = videoRef.current;
    let player: Player | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const mpegts = (await import('mpegts.js')).default;
        if (cancelled || !mpegts.isSupported()) {
          if (!cancelled) setFailed(true);
          return;
        }
        const created = mpegts.createPlayer(
          { type: 'mpegts', isLive: false, url: src, cors: true },
          { enableWorker: false },
        );
        if (cancelled) {
          created.destroy();
          return;
        }
        player = created;
        player.attachMediaElement(element);
        player.load();
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      player?.destroy();
    };
  }, [src, isMpegTs]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (v === null) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  const seek = (value: number) => {
    const v = videoRef.current;
    if (v === null) return;
    v.currentTime = value;
    setCurrentTime(value);
  };

  const toggleFullscreen = async () => {
    const el = containerRef.current;
    if (el === null) return;
    if (document.fullscreenElement === null) await el.requestFullscreen?.();
    else await document.exitFullscreen?.();
  };

  const formatTime = (s: number) => {
    if (!Number.isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${r.toString().padStart(2, '0')}`;
  };

  if (failed) {
    return (
      <div className="preview__status">
        <p>Your browser cannot play this video. Download it to open it.</p>
        <button type="button" className="btn btn--ghost" onClick={() => { setFailed(false); videoRef.current?.load(); }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="video-player" ref={containerRef}>
      <video
        ref={videoRef}
        className="preview__video"
        src={isMpegTs ? undefined : src}
        playsInline
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setDuration(videoRef.current?.duration ?? 0)}
        onWaiting={() => {
          setBuffering(true);
          if (stallTimer.current !== null) clearTimeout(stallTimer.current);
          stallTimer.current = setTimeout(() => {
            const v = videoRef.current;
            if (v === null) return;
            // Nudge a stalled read: reopen the resource at the current position.
            const pos = v.currentTime;
            v.load();
            const onReady = () => {
              v.currentTime = pos;
              v.removeEventListener('canplay', onReady);
            };
            v.addEventListener('canplay', onReady, { once: true });
          }, 8000);
        }}
        onProgress={() => {
          const v = videoRef.current;
          if (v === null || v.duration <= 0 || v.buffered.length === 0) return;
          const end = v.buffered.end(v.buffered.length - 1);
          setBufferedPercent(Math.min(100, Math.round((end / v.duration) * 100)));
        }}
        onCanPlay={() => {
          setBuffering(false);
          if (stallTimer.current !== null) {
            clearTimeout(stallTimer.current);
            stallTimer.current = null;
          }
        }}
        onError={() => setFailed(true)}
      />
      {buffering && (
        <div className="video-player__spinner" aria-hidden="true">
          <Icon name="info" size={20} />
        </div>
      )}
      <div className="video-player__controls">
        <button type="button" className="btn btn--ghost btn--icon" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          className="video-player__seek"
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={currentTime}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Seek"
        />
        <span className="video-player__time mono">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        <span className="video-player__buffered mono">Buffered {bufferedPercent}%</span>
        <input
          className="video-player__volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => {
            const v = videoRef.current;
            const val = Number(e.target.value);
            setVolume(val);
            setMuted(val === 0);
            if (v !== null) {
              v.volume = val;
              v.muted = val === 0;
            }
          }}
          aria-label="Volume"
        />
        <button type="button" className="btn btn--ghost btn--icon" onClick={() => void toggleFullscreen()} aria-label="Fullscreen">
          Fullscreen
        </button>
      </div>
    </div>
  );
}