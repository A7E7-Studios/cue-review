import { useCallback, useState } from 'react';
import { backend } from '../backend';
import type { CaptureSource, Microphone } from '../backend';

export const MICROPHONE_UNAVAILABLE = 'The selected microphone is unavailable. Reconnect it and refresh microphones, choose another input, or select No microphone.';
const SOURCE_PRIORITY: Record<CaptureSource['kind'], number> = { display: 0, window: 1, android: 2, quest: 2, camera: 3 };

/**
 * Capture sources, microphones and the current choices. A choice that disappears on
 * refresh stays selected as an unavailable placeholder instead of silently changing.
 */
export function useCaptureDevices() {
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [microphones, setMicrophones] = useState<Microphone[]>([]);
  const [sourceId, setSourceId] = useState('');
  /** '' is No microphone; undefined until the list has loaded. */
  const [microphoneId, setMicrophoneId] = useState<string | undefined>(undefined);
  const [systemAudio, setSystemAudio] = useState(false);
  const [muted, setMuted] = useState(false);

  const refreshDevices = useCallback(async () => {
    const [videoSources, audioSources] = await Promise.all([backend.sources(), backend.microphones()]);
    // Keep discovery order within each kind, without changing the backend's list.
    const ordered = [...videoSources].sort((left, right) => SOURCE_PRIORITY[left.kind] - SOURCE_PRIORITY[right.kind]);
    setSources(ordered); setMicrophones(audioSources);
    setSourceId(current => current || ordered.find(item => item.available)?.id || '');
    setMicrophoneId(current => current ?? audioSources[0]?.id ?? '');
  }, []);

  const source: CaptureSource | undefined = sources.find(item => item.id === sourceId) || (sourceId ? {
    id: sourceId, name: 'Previously selected source', kind: 'display', available: false,
    detail: 'The previously selected capture source is no longer available. Reconnect it and refresh, or choose another source.',
  } : undefined);
  const microphone = microphones.find(item => item.id === microphoneId);
  const microphoneUnavailable = !!microphoneId && !microphone;
  /** The listed sources, led by the placeholder for a vanished choice. */
  const sourceOptions = source && !sources.some(item => item.id === sourceId) ? [source, ...sources] : sources;

  return {
    sources, sourceOptions, microphones, source, microphone, microphoneUnavailable,
    sourceId, setSourceId, microphoneId, setMicrophoneId, systemAudio, setSystemAudio, muted, setMuted, refreshDevices,
  };
}
