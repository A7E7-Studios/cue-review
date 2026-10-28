import { useEffect, useState } from 'react';
import { backend } from '../backend';
import { errorMessage } from '../review';

/**
 * The live preview of `sourceId` while `enabled`. Changing `revision` reconnects it.
 * A failure reported by the stream removes the last frame and says what failed.
 */
export function usePreviewStream(sourceId: string, enabled: boolean, revision: number) {
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState('');
  useEffect(() => {
    setPreview(''); setPreviewError('');
    if (!sourceId || !enabled) return;
    let alive = true;
    let failed = false;
    const id = crypto.randomUUID();
    const fail = (problem: unknown) => { failed = true; if (alive) { setPreview(''); setPreviewError(errorMessage(problem)); } };
    void backend.preview(sourceId, id, fail).then(stream => { if (alive && !failed) { setPreview(stream.url); setPreviewError(''); } }).catch(fail);
    return () => { alive = false; void backend.stopPreview(id).catch(() => {}); };
  }, [sourceId, enabled, revision]);
  return { preview, previewError };
}
