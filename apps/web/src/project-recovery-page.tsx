import { useEffect, useMemo, useState } from 'react';
import { parseSnapshot } from '@selene/collaboration';
import { ProjectRecoveryPanel } from './project-recovery-panel';
import { createProjectRecoveryBrowserClient } from './project-recovery-model';
import type { ProjectRestoreReceipt } from '../../collaboration-service/src/project-backup-contract';

async function readSnapshot(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('The project snapshot is empty.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- Consume bounded stream chunks in order.
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2 * 1024 * 1024)
        throw new Error('The project snapshot exceeds the supported size.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function retryDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function ProjectRecoveryPage({ serviceUrl }: { readonly serviceUrl: string | undefined }) {
  const projectId = new URL(window.location.href).searchParams.get('recoveryProject') ?? '';
  const [revisionId, setRevisionId] = useState<string>();
  const [status, setStatus] = useState('Loading the current project revision…');
  const [reload, setReload] = useState(0);
  const [lastRestore, setLastRestore] = useState<ProjectRestoreReceipt>();
  const actions = useMemo(() => {
    if (serviceUrl === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId))
      return undefined;
    try {
      return createProjectRecoveryBrowserClient(serviceUrl);
    } catch {
      return undefined;
    }
  }, [serviceUrl, projectId]);
  useEffect(() => {
    const controller = new AbortController();
    setRevisionId(undefined);
    if (actions === undefined || serviceUrl === undefined) {
      setStatus('Project recovery requires a configured team service and a valid project link.');
      return () => controller.abort();
    }
    setStatus('Loading the current project revision…');
    void (async () => {
      try {
        let response: Response;
        for (let attempt = 0; ; attempt += 1) {
          // oxlint-disable-next-line no-await-in-loop -- Retry only after the previous transient response.
          response = await fetch(
            new URL(`/v1/projects/${encodeURIComponent(projectId)}/export`, serviceUrl),
            {
              credentials: 'include',
              cache: 'no-store',
              redirect: 'error',
              signal: controller.signal
            }
          );
          if (![502, 503, 504].includes(response.status) || attempt === 2) break;
          // oxlint-disable-next-line no-await-in-loop -- Release the failed response before retrying.
          await response.body?.cancel();
          // oxlint-disable-next-line no-await-in-loop -- Bounded backoff precedes the next attempt.
          await retryDelay(200 * (attempt + 1), controller.signal);
        }
        if (!response.ok) throw new Error();
        const bytes = await readSnapshot(response);
        const snapshot = parseSnapshot(bytes);
        const latest = snapshot.revisions.reduce(
          (previous, current) =>
            current.sequence > (previous?.sequence ?? -1) ? current : previous,
          undefined as (typeof snapshot.revisions)[number] | undefined
        );
        if (snapshot.project.id !== projectId || latest === undefined) throw new Error();
        if (!controller.signal.aborted) {
          setRevisionId(latest.id);
          setStatus('');
        }
      } catch {
        if (!controller.signal.aborted)
          setStatus(
            'The current project could not be loaded. Sign in with owner or admin access, then retry.'
          );
      }
    })();
    return () => controller.abort();
  }, [actions, serviceUrl, projectId, reload]);
  return (
    <main style={{ maxWidth: 960, margin: 'auto', padding: 24 }}>
      <h1>Team project recovery</h1>
      <a href={window.location.pathname}>Return to workspace</a>
      {status.length > 0 ? <p role="status">{status}</p> : null}
      <button type="button" onClick={() => setReload((value) => value + 1)}>
        Refresh current revision
      </button>
      {lastRestore?.projectId === projectId ? (
        <p>
          Restored {lastRestore.restoredRevisionId}; previous revision{' '}
          {lastRestore.previousRevisionId}. Verified restore audit: {lastRestore.restoreAuditId};
          preserved audit identities:{' '}
          {lastRestore.preservedAuditIds.join(', ') || 'None in this backup'}.
        </p>
      ) : null}
      {revisionId !== undefined && actions !== undefined ? (
        <ProjectRecoveryPanel
          projectId={projectId}
          currentRevisionId={revisionId}
          actions={actions}
          onRestored={(receipt) => {
            setLastRestore(receipt);
            setReload((value) => value + 1);
          }}
        />
      ) : null}
    </main>
  );
}
