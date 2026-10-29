import { createRef } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { captureEmptyState, MediaStage, reviewEmptyState } from './MediaStage';
import { NAMES } from './types';

describe('MediaStage', () => {
  it('plays the review video in one bordered box and forwards its element and handlers', () => {
    const ref = createRef<HTMLVideoElement>();
    const onTimeUpdate = vi.fn();
    const onLoadedMetadata = vi.fn();
    render(<MediaStage mode="review" videoSrc="asset://video.mp4" videoKey="s1:0" videoRef={ref} videoProps={{ onTimeUpdate, onLoadedMetadata, onClick: vi.fn() }}>
      <div role="group" aria-label="Playback"/>
    </MediaStage>);
    const region = screen.getByRole('region', { name: 'Recording video' });
    const video = region.querySelector('video')!;
    expect(video).toBe(ref.current);
    expect(video).toHaveAttribute('src', 'asset://video.mp4');
    fireEvent.timeUpdate(video);
    fireEvent.loadedMetadata(video);
    expect(onTimeUpdate).toHaveBeenCalledTimes(1);
    expect(onLoadedMetadata).toHaveBeenCalledTimes(1);
    // The controls slot follows the media, outside its region.
    expect(within(region).queryByRole('group', { name: 'Playback' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Playback' })).toBeInTheDocument();
  });
  it('shows the live preview with its hook class while drafting', () => {
    render(<MediaStage mode="draft" previewUrl="http://127.0.0.1:9999/live" sourceName="Display 1"/>);
    const image = within(screen.getByRole('region', { name: 'Capture preview' })).getByRole('img', { name: 'Live preview of Display 1' });
    expect(image).toHaveClass('preview-image');
    expect(screen.queryByText(/^Live/)).not.toBeInTheDocument();
  });
  it('reports a preview image that fails to load and offers Retry beside a preview error', () => {
    const onPreviewError = vi.fn();
    const onRetryPreview = vi.fn();
    const { rerender } = render(<MediaStage mode="draft" previewUrl="http://127.0.0.1:9999/live?view=1" sourceName="Display 1" onPreviewError={onPreviewError} onRetryPreview={onRetryPreview}/>);
    fireEvent.error(screen.getByRole('img', { name: 'Live preview of Display 1' }));
    expect(onPreviewError).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: NAMES.retryPreview })).not.toBeInTheDocument();
    rerender(<MediaStage mode="draft" previewError="The preview stopped updating." empty={captureEmptyState({ source: { available: true }, previewError: 'The preview stopped updating.' })} onPreviewError={onPreviewError} onRetryPreview={onRetryPreview}/>);
    expect(screen.getByRole('heading', { name: 'Preview unavailable' })).toBeVisible();
    expect(screen.getByText('The preview stopped updating.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: NAMES.retryPreview }));
    expect(onRetryPreview).toHaveBeenCalledTimes(1);
  });
  it('marks a recording with the red ring and a "Live · source" badge', () => {
    render(<MediaStage mode="recording" previewUrl="http://127.0.0.1:9999/live" sourceName="Display 1"/>);
    const region = screen.getByRole('region', { name: 'Capture preview' });
    expect(region).toHaveAttribute('data-live');
    expect(within(region).getByText('Live · Display 1')).toBeVisible();
  });
  it('keeps the empty, unavailable, loading and error texts', () => {
    const { rerender } = render(<MediaStage mode="draft" empty={captureEmptyState({ source: { available: false } })} previewError="Preview stream stopped."/>);
    expect(screen.getByRole('heading', { name: 'Capture source unavailable' })).toBeVisible();
    expect(screen.getByText('Reconnect the selected source and refresh, or choose another source.')).toBeVisible();
    expect(screen.getByText('Preview stream stopped.')).toBeVisible();
    rerender(<MediaStage mode="review" empty={reviewEmptyState({ processing: true })}/>);
    expect(screen.getByRole('heading', { name: 'Finishing your recording' })).toBeVisible();
    expect(screen.getByText('Finishing video and transcript…')).toBeVisible();
    rerender(<MediaStage mode="review"/>);
    expect(screen.getByRole('heading', { name: 'No video available' })).toBeVisible();
  });
  it('describes every capture state with today’s wording', () => {
    expect(captureEmptyState({})).toEqual({ title: 'Choose a source' });
    expect(captureEmptyState({ loading: true, source: { available: true } })).toEqual({ title: 'Loading…' });
    expect(captureEmptyState({ source: { available: true } })).toEqual({ title: 'Loading preview…' });
    expect(captureEmptyState({ source: { available: true }, previewError: 'Stream failed' })).toEqual({ title: 'Preview unavailable' });
    expect(captureEmptyState({ source: { available: false, detail: 'Reconnect Quest.' } })).toEqual({ title: 'Capture source unavailable', detail: 'Reconnect Quest.' });
    expect(captureEmptyState({ paused: true })).toEqual({ title: 'Camera preview paused', detail: 'The camera is in use for recording. Preview returns when you start a new session.' });
    expect(reviewEmptyState({ loading: true }).title).toBe('Opening recording…');
    expect(reviewEmptyState()).toEqual({ title: 'No video available', detail: 'Open the session folder to inspect its files.' });
  });
});
