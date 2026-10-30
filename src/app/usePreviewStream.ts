import { useCallback, useEffect, useRef, useState } from 'react';
import { backend } from '../backend';
import { errorMessage } from '../review';

/** Waits before reconnecting a dropped or failed image connection. After the last one the preview offers Retry. */
export const PREVIEW_RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;
/** A connection that lasted this long was healthy, so its drop starts the backoff over. */
export const PREVIEW_HEALTHY_MS = 10_000;
export const PREVIEW_LOST = 'The preview stopped updating.';
export const PREVIEW_FIRST_FRAME_TIMEOUT = 'No preview frame appeared. Check camera or screen access in system settings, reconnect the source, then retry.';

/**
 * The stream URL for image connection `view`. The backend reports the label of a connection
 * that ended. Only loopback HTTP streams take it; other URLs (a story's data URL) stay as they are.
 */
export function viewerUrl(url: string, view: number): string {
  if (!/^https?:/i.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}view=${view}`;
}

/**
 * The live preview of `sourceId` while `enabled`. Changing `revision` restarts it.
 * When the backend reports that the image's connection ended, or the image fails to load
 * (`onPreviewError`), the image reconnects to the same stream with backoff. A failure reported
 * by the stream, or a connection that keeps failing, removes the last frame and says what failed.
 */
export function usePreviewStream(sourceId: string, enabled: boolean, revision: number) {
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState('');
  /** The current image connection, numbered across streams so a late report from an old one is ignored. */
  const view = useRef(0);
  const lost = useRef<(view: number) => void>(() => {});
  const timedOut = useRef<(url: string, view: number) => void>(() => {});
  useEffect(() => {
    setPreview(''); setPreviewError('');
    if (!sourceId || !enabled) return;
    let alive = true;
    let failed = false;
    let stream = '';
    let attempts = 0;
    let connectedAt = 0;
    let timer: number | undefined;
    const id = crypto.randomUUID();
    const fail = (problem: unknown) => {
      if (!alive || failed) return;
      failed = true; window.clearTimeout(timer); timer = undefined;
      setPreview(''); setPreviewError(errorMessage(problem));
    };
    const connect = () => { view.current += 1; connectedAt = Date.now(); setPreview(viewerUrl(stream, view.current)); };
    timedOut.current = (url, reportedView) => {
      if (!alive || failed || !stream || timer !== undefined || reportedView !== view.current || url !== viewerUrl(stream, view.current)) return;
      fail(PREVIEW_FIRST_FRAME_TIMEOUT);
      void backend.stopPreview(id).catch(() => {});
    };
    lost.current = dropped => {
      if (!alive || failed || !stream || dropped !== view.current || timer !== undefined) return;
      if (Date.now() - connectedAt >= PREVIEW_HEALTHY_MS) attempts = 0;
      const delay = PREVIEW_RECONNECT_DELAYS_MS[attempts++];
      if (delay === undefined) { fail(PREVIEW_LOST); return; }
      timer = window.setTimeout(() => { timer = undefined; if (alive && !failed) connect(); }, delay);
    };
    void backend.preview(sourceId, id, fail, dropped => lost.current(Number(dropped)))
      .then(info => { if (alive && !failed) { stream = info.url; setPreviewError(''); connect(); } })
      .catch(fail);
    return () => {
      alive = false; window.clearTimeout(timer); lost.current = () => {}; timedOut.current = () => {};
      void backend.stopPreview(id).catch(() => {});
    };
  }, [sourceId, enabled, revision]);
  // Capture the connection number as well as its URL: fixtures can reuse a data URL across sources.
  const renderedView = view.current;
  /** The image could not load its stream; ignore an old image's delayed error. */
  const onPreviewError = useCallback(() => lost.current(renderedView), [renderedView]);
  const onPreviewTimeout = useCallback((url: string) => timedOut.current(url, renderedView), [renderedView]);
  return { preview, previewError, onPreviewError, onPreviewTimeout };
}
