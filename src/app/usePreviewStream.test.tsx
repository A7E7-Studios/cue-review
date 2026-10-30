import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_HEALTHY_MS, PREVIEW_LOST, PREVIEW_RECONNECT_DELAYS_MS, usePreviewStream, viewerUrl } from './usePreviewStream';

const backend = vi.hoisted(() => ({ preview: vi.fn(), stopPreview: vi.fn() }));
vi.mock('../backend', () => ({ backend }));

type Drop = (view: string) => void;
const drop = (call = 0) => backend.preview.mock.calls[call][3] as Drop;
const fail = (call = 0) => backend.preview.mock.calls[call][2] as (error: string) => void;

async function started(sourceId = 'display1', revision = 0) {
  const hook = renderHook(({ revision }) => usePreviewStream(sourceId, true, revision), { initialProps: { revision } });
  await act(async () => {});
  return hook;
}

describe('usePreviewStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    backend.preview.mockReset().mockImplementation(async (_source: string, id: string) => ({ id, url: 'http://127.0.0.1:9000/token' }));
    backend.stopPreview.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('fails a first-frame timeout with useful Retry guidance and releases the stream', async () => {
    const { result, rerender } = await started('avfoundation:0');
    const oldTimeout = result.current.onPreviewTimeout;
    const oldUrl = result.current.preview;
    act(() => oldTimeout(oldUrl));
    expect(result.current.preview).toBe('');
    expect(result.current.previewError).toMatch(/No preview frame appeared.*camera.*retry/i);
    expect(backend.stopPreview).toHaveBeenCalledWith(backend.preview.mock.calls[0][1]);
    const timeoutError = result.current.previewError;
    act(() => fail()('Preview stream ended during teardown'));
    expect(result.current.previewError).toBe(timeoutError);
    rerender({ revision: 1 });
    await act(async () => {});
    expect(result.current.preview).toContain('view=2');
    expect(result.current.previewError).toBe('');
    act(() => oldTimeout(oldUrl));
    expect(result.current.preview).toContain('view=2');
    expect(result.current.previewError).toBe('');
  });

  it('ignores timeout reports for an obsolete URL or a connection awaiting reconnect', async () => {
    const { result } = await started();
    const oldUrl = result.current.preview;
    act(() => result.current.onPreviewTimeout('http://127.0.0.1:9000/other?view=1'));
    expect(result.current.previewError).toBe('');
    act(() => drop()('1'));
    act(() => result.current.onPreviewTimeout(oldUrl));
    expect(result.current.previewError).toBe('');
    act(() => { vi.advanceTimersByTime(PREVIEW_RECONNECT_DELAYS_MS[0]); });
    expect(result.current.preview).toContain('view=2');
  });

  it('ignores a late image error from an obsolete connection', async () => {
    const { result } = await started();
    const oldError = result.current.onPreviewError;
    act(() => drop()('1'));
    act(() => { vi.advanceTimersByTime(PREVIEW_RECONNECT_DELAYS_MS[0]); });
    expect(result.current.preview).toContain('view=2');
    act(() => oldError());
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.preview).toContain('view=2');
    expect(result.current.previewError).toBe('');
  });

  it('ignores a timeout callback from a previous source even when its fixture image URL is reused', async () => {
    backend.preview.mockImplementation(async (_source: string, id: string) => ({ id, url: 'data:image/svg+xml,<svg/>' }));
    const { result, rerender } = renderHook(({ source }) => usePreviewStream(source, true, 0), { initialProps: { source: 'first' } });
    await act(async () => {});
    const oldTimeout = result.current.onPreviewTimeout;
    const oldUrl = result.current.preview;
    rerender({ source: 'second' });
    await act(async () => {});
    act(() => oldTimeout(oldUrl));
    expect(result.current.preview).toBe(oldUrl);
    expect(result.current.previewError).toBe('');
  });

  it('numbers each image connection on the stream URL', () => {
    expect(viewerUrl('http://127.0.0.1:9000/token', 3)).toBe('http://127.0.0.1:9000/token?view=3');
    expect(viewerUrl('http://127.0.0.1:9000/token?a=1', 4)).toBe('http://127.0.0.1:9000/token?a=1&view=4');
    expect(viewerUrl('data:image/svg+xml,<svg/>', 5)).toBe('data:image/svg+xml,<svg/>');
  });

  it('reconnects a dropped connection after a backoff and ignores reports about older ones', async () => {
    const { result } = await started();
    expect(result.current.preview).toBe('http://127.0.0.1:9000/token?view=1');
    act(() => drop()('1'));
    // The same report again, while the reconnect waits, schedules nothing more.
    act(() => drop()('1'));
    act(() => { vi.advanceTimersByTime(PREVIEW_RECONNECT_DELAYS_MS[0] - 1); });
    expect(result.current.preview).toBe('http://127.0.0.1:9000/token?view=1');
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.preview).toBe('http://127.0.0.1:9000/token?view=2');
    // The old connection ending later (the image let go of it) changes nothing.
    act(() => drop()('1'));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.preview).toBe('http://127.0.0.1:9000/token?view=2');
    expect(backend.preview).toHaveBeenCalledTimes(1);
    expect(result.current.previewError).toBe('');
  });

  it('backs off while the image keeps failing, then reports the lost preview', async () => {
    const { result } = await started();
    for (const [index, delay] of PREVIEW_RECONNECT_DELAYS_MS.entries()) {
      act(() => result.current.onPreviewError());
      act(() => { vi.advanceTimersByTime(delay - 1); });
      expect(result.current.preview).toBe(`http://127.0.0.1:9000/token?view=${index + 1}`);
      act(() => { vi.advanceTimersByTime(1); });
      expect(result.current.preview).toBe(`http://127.0.0.1:9000/token?view=${index + 2}`);
    }
    act(() => result.current.onPreviewError());
    expect(result.current.preview).toBe('');
    expect(result.current.previewError).toBe(PREVIEW_LOST);
    // Nothing reconnects a lost preview but a restart.
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current.preview).toBe('');
  });

  it('starts the backoff over after a connection that stayed up', async () => {
    const { result } = await started();
    for (const delay of PREVIEW_RECONNECT_DELAYS_MS) {
      act(() => result.current.onPreviewError());
      act(() => { vi.advanceTimersByTime(delay); });
    }
    act(() => { vi.advanceTimersByTime(PREVIEW_HEALTHY_MS); });
    const healthy = result.current.preview;
    act(() => drop()(healthy.split('view=')[1]));
    act(() => { vi.advanceTimersByTime(PREVIEW_RECONNECT_DELAYS_MS[0]); });
    expect(result.current.preview).not.toBe(healthy);
    expect(result.current.previewError).toBe('');
  });

  it('a stream failure removes the frame and cancels a pending reconnect; a new revision starts over', async () => {
    const { result, rerender, unmount } = await started();
    act(() => drop()('1'));
    act(() => fail()('Preview stream ended. Reconnect the source and select it again.'));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.preview).toBe('');
    expect(result.current.previewError).toBe('Preview stream ended. Reconnect the source and select it again.');
    rerender({ revision: 1 });
    await act(async () => {});
    expect(backend.stopPreview).toHaveBeenCalledWith(backend.preview.mock.calls[0][1]);
    expect(result.current.previewError).toBe('');
    // Connection numbers keep counting, so a late report from the first stream matches nothing.
    expect(result.current.preview).toBe('http://127.0.0.1:9000/token?view=2');
    act(() => drop(0)('1'));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.preview).toBe('http://127.0.0.1:9000/token?view=2');
    act(() => drop(1)('2'));
    act(() => { vi.advanceTimersByTime(PREVIEW_RECONNECT_DELAYS_MS[0]); });
    expect(result.current.preview).toBe('http://127.0.0.1:9000/token?view=3');
    unmount();
    expect(backend.stopPreview).toHaveBeenCalledWith(backend.preview.mock.calls[1][1]);
  });
});
