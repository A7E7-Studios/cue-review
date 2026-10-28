import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { CaptureSource } from '../backend';
import { Icon } from '../icons';
import { DEFAULT_ASPECT, mediaAspect, useMediaFit } from './mediaFit';
import { NAMES } from './types';
import type { MediaEmptyState, MediaStageProps } from './types';
import './workspace.css';

/** The draft and recording empty states, with today's texts. */
export function captureEmptyState({ source, loading = false, paused = false, previewError }: {
  source?: Pick<CaptureSource, 'available' | 'detail'>;
  loading?: boolean;
  /** An exclusive camera is in use by the recording. */
  paused?: boolean;
  /** A failed stream says what failed instead of "Loading preview…". */
  previewError?: string;
}): MediaEmptyState {
  if (paused) return { title: 'Camera preview paused', detail: 'The camera is in use for recording. Preview returns when you start a new session.' };
  if (loading) return { title: 'Loading…' };
  if (source && !source.available) return { title: 'Capture source unavailable', detail: source.detail || 'Reconnect the selected source and refresh, or choose another source.' };
  if (source) return { title: previewError ? 'Preview unavailable' : 'Loading preview…' };
  return { title: 'Choose a source' };
}

/** The review empty states (no playable video), with today's texts. */
export function reviewEmptyState({ loading = false, processing = false }: { loading?: boolean; processing?: boolean } = {}): MediaEmptyState {
  return {
    title: loading ? 'Opening recording…' : processing ? 'Finishing your recording' : 'No video available',
    detail: processing ? 'Finishing video and transcript…' : 'Open the session folder to inspect its files.',
  };
}

export interface MediaStageViewProps extends MediaStageProps {
  /** The controls slot directly under the media: PlaybackBar, RecordingDock or CaptureControls. */
  children?: ReactNode;
}

/**
 * The video or live preview with one border, top-aligned under the title and
 * sized to fit the stage in both directions (decision 1). The controls passed as
 * children sit directly under it; unused space stays below them.
 */
export function MediaStage({ mode, previewUrl, sourceName, previewError, videoSrc, videoKey, videoRef, videoProps, empty, focused = false, children }: MediaStageViewProps) {
  const stage = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const capture = mode !== 'review';
  const live = mode === 'recording';
  const url = capture ? previewUrl : videoSrc;
  const [measured, setMeasured] = useState<{ url?: string; aspect: number }>({ aspect: DEFAULT_ASPECT });
  const aspect = url && measured.url === url ? measured.aspect : DEFAULT_ASPECT;
  const fitted = useMediaFit(stage, controls, aspect);
  const remember = (width: number, height: number) => { if (url && width && height) setMeasured({ url, aspect: mediaAspect(width, height) }); };

  // A multipart preview stream may not fire `load`; read its size once frames arrive.
  useEffect(() => {
    if (!capture || !previewUrl) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const frame = image.current;
      if (frame?.naturalWidth && frame.naturalHeight) {
        setMeasured({ url: previewUrl, aspect: mediaAspect(frame.naturalWidth, frame.naturalHeight) });
        window.clearInterval(timer);
      } else if (++tries > 40) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [capture, previewUrl]);

  const { onLoadedMetadata, ...forwarded } = videoProps ?? {};
  const style = { '--cr-media-aspect': String(aspect), ...(fitted ? { width: fitted.width, height: fitted.height } : {}) } as CSSProperties;
  const fallback = empty ?? (capture ? captureEmptyState({}) : reviewEmptyState());

  return <div ref={stage} className="cr-stage" data-mode={mode} data-focused={focused || undefined}>
    <section className="cr-media" aria-label={capture ? NAMES.capturePreview : NAMES.recordingVideo} data-live={live || undefined} data-fitted={fitted ? '' : undefined} style={style}>
      {capture
        ? previewUrl
          ? <img ref={image} className="preview-image" src={previewUrl} alt={NAMES.livePreview(sourceName || 'capture source')} onLoad={event => remember(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}/>
          : <EmptyMedia state={fallback}/>
        : videoSrc
          ? <video key={videoKey} ref={videoRef} playsInline preload="metadata" {...forwarded} src={videoSrc}
              onLoadedMetadata={event => { remember(event.currentTarget.videoWidth, event.currentTarget.videoHeight); onLoadedMetadata?.(event); }}/>
          : <EmptyMedia state={fallback}/>}
      {capture && previewError && <p className="cr-preview-error">{previewError}</p>}
      {live && <span className="cr-live-badge"><i aria-hidden="true"/>{sourceName ? `Live · ${sourceName}` : 'Live'}</span>}
    </section>
    <div ref={controls} className="cr-stage-controls">{children}</div>
  </div>;
}

function EmptyMedia({ state }: { state: MediaEmptyState }) {
  return <div className="cr-media-empty">
    <Icon name="monitor" strokeWidth={1.2}/>
    <h2>{state.title}</h2>
    {state.detail && <p>{state.detail}</p>}
  </div>;
}
