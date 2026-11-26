'use client';

/**
 * A voice note.
 *
 * The waveform is computed from the audio itself, not decorative: the bytes are
 * already decrypted in memory, so they get decoded once and reduced to a few
 * dozen amplitude buckets. A flat recording looks flat and a loud one looks
 * loud, which is the only reason to draw a waveform at all.
 *
 * Where the browser cannot decode the codec — exported voice notes are often
 * Opus in an Ogg container, which Safari has historically refused — it falls
 * back to the platform audio control rather than drawing a fake waveform.
 *
 * The scrubber is a real slider: focusable, arrow keys seek, Home and End jump
 * to the ends, and it reports its position to assistive technology.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cx } from '@/components/ui';

const BUCKETS = 44;

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}

/** Reduce a decoded buffer to one root-mean-square value per bucket. */
function peaksFrom(buffer: AudioBuffer, buckets = BUCKETS): number[] {
  const channel = buffer.getChannelData(0);
  const size = Math.max(1, Math.floor(channel.length / buckets));
  const peaks: number[] = [];
  let loudest = 0;

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = bucket * size;
    let sum = 0;
    let counted = 0;
    for (let i = start; i < start + size && i < channel.length; i += 1) {
      const sample = channel[i] as number;
      sum += sample * sample;
      counted += 1;
    }
    const rms = counted > 0 ? Math.sqrt(sum / counted) : 0;
    peaks.push(rms);
    loudest = Math.max(loudest, rms);
  }

  // Normalise against the loudest bucket, so a quiet recording is still visible.
  return peaks.map((value) => (loudest > 0 ? Math.min(1, value / loudest) : 0));
}

type DecodeState = 'decoding' | 'ready' | 'unsupported';

export function VoiceNote({
  bytes,
  url,
  fileName,
  byteLength,
}: {
  bytes: Uint8Array;
  url: string;
  fileName: string;
  byteLength: number | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [decodeState, setDecodeState] = useState<DecodeState>('decoding');
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);

  /* Decode once, off the render path, and release the context afterwards. */
  useEffect(() => {
    let active = true;

    void (async () => {
      const AudioContextCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        if (active) setDecodeState('unsupported');
        return;
      }

      const context = new AudioContextCtor();
      try {
        // decodeAudioData detaches the buffer it is given, so hand it a copy.
        const decoded = await context.decodeAudioData(bytes.slice().buffer);
        if (!active) return;
        setPeaks(peaksFrom(decoded));
        setDuration(decoded.duration);
        setDecodeState('ready');
      } catch {
        if (active) setDecodeState('unsupported');
      } finally {
        void context.close().catch(() => undefined);
      }
    })();

    return () => {
      active = false;
    };
  }, [bytes]);

  const seekTo = useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      if (!audio || !Number.isFinite(seconds)) return;
      const clamped = Math.max(0, Math.min(seconds, duration || audio.duration || 0));
      audio.currentTime = clamped;
      setPosition(clamped);
    },
    [duration],
  );

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  };

  const onBarClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const ratio = (event.clientX - box.left) / box.width;
    seekTo(ratio * (duration || 0));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 5;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      seekTo(position + step);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      seekTo(position - step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      seekTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      seekTo(duration);
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      toggle();
    }
  };

  if (decodeState === 'unsupported') {
    return (
      <div className="space-y-1">
        {/* An archived voice note has no caption track, and inventing one
            would be worse than having none. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio src={url} controls className="w-full" preload="metadata" />
        <p className="muted text-[11px]">
          {fileName}
          {byteLength ? ` · ${String(Math.round(byteLength / 1024))} kB` : ''} · this browser cannot
          draw a waveform for this format
        </p>
      </div>
    );
  }

  const progress = duration > 0 ? Math.min(1, position / duration) : 0;

  return (
    <div className="flex min-w-[15rem] items-center gap-2.5 py-0.5">
      {/* The engine behind the waveform: never shown, never focusable, and with
          no caption track to offer. The visible controls are below. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPosition(0);
        }}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          if (Number.isFinite(event.currentTarget.duration)) {
            setDuration(event.currentTarget.duration);
          }
        }}
        className="hidden"
      />

      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? `Pause ${fileName}` : `Play ${fileName}`}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-500 text-white hover:bg-accent-600"
      >
        <span aria-hidden="true" className="text-sm leading-none">
          {playing ? '❚❚' : '▶'}
        </span>
      </button>

      <div className="min-w-0 flex-1 space-y-1">
        <div
          role="slider"
          tabIndex={0}
          aria-label={`Position in ${fileName}`}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(position)}
          aria-valuetext={`${formatDuration(position)} of ${formatDuration(duration)}`}
          onClick={onBarClick}
          onKeyDown={onKeyDown}
          className="flex h-8 cursor-pointer items-center gap-[2px] rounded"
        >
          {(peaks.length > 0 ? peaks : Array.from({ length: BUCKETS }, () => 0.12)).map(
            (peak, index) => {
              const played = index / BUCKETS <= progress;
              return (
                <span
                  key={index}
                  className={cx(
                    'w-full rounded-full transition-colors',
                    played ? 'bg-accent-500' : 'bg-ink-300 dark:bg-ink-600',
                  )}
                  style={{ height: `${String(Math.max(12, Math.round(peak * 100)))}%` }}
                />
              );
            },
          )}
        </div>

        <div className="muted flex items-center gap-2 text-[11px] tabular-nums">
          <span>
            {formatDuration(playing || position > 0 ? position : duration)}
            {decodeState === 'decoding' ? ' · reading…' : ''}
          </span>
          <button
            type="button"
            onClick={() => {
              const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
              setSpeed(next);
              if (audioRef.current) audioRef.current.playbackRate = next;
            }}
            className="ml-auto rounded px-1.5 py-0.5 hover:bg-ink-200 dark:hover:bg-ink-700"
            aria-label={`Playback speed, currently ${String(speed)} times`}
          >
            {speed}×
          </button>
        </div>
      </div>
    </div>
  );
}
