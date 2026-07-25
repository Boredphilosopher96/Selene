import { useState } from 'react';

import type { DesignerSnapshot } from '../../../shared/designer-api';
import type { WorkspaceControlActions } from './workspace-controls';

export interface WorkspaceToolbarProps {
  readonly actions: WorkspaceControlActions;
  readonly onSnapshot: (snapshot: DesignerSnapshot) => void;
  readonly onStatus: (message: string) => void;
  readonly onPublish: (repository: string, title: string) => Promise<void>;
}

/** Daily actions stay compact; operational controls remain discoverable in an explicit panel. */
export function WorkspaceToolbar({ actions, onSnapshot, onStatus, onPublish }: WorkspaceToolbarProps) {
  const [more, setMore] = useState(false);
  const [repository, setRepository] = useState('owner/desktop-design');
  const [title, setTitle] = useState('Review generated desktop flow');
  const [diagnostics, setDiagnostics] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const run = (work: Promise<unknown>, success: string) => void work.then((value) => {
    if (value && typeof value === 'object' && 'apiVersion' in value) onSnapshot(value as DesignerSnapshot);
    onStatus(success);
  }).catch((error: unknown) => onStatus(error instanceof Error ? error.message : 'Workspace action failed.'));
  return <div className="workspace-toolbar" role="toolbar" aria-label="Daily workspace actions">
    <button type="button" onClick={() => run(actions.render(), 'Rendered current revision.')}>Render</button>
    <button type="button" onClick={() => run(actions.markReadyForReview(), 'Marked ready for review.')}>Review</button>
    <button type="button" onClick={() => run(actions.markReadyForHandoff(), 'Marked ready for handoff.')}>Handoff</button>
    <button type="button" onClick={() => run(onPublish(repository, title), 'Hosted review requested.')}>Publish</button>
    <button type="button" aria-expanded={more} onClick={() => setMore((value) => !value)}>More</button>
    {more ? <section className="workspace-toolbar__more" aria-label="Workspace operations">
      <label>Repository<input value={repository} onChange={(event) => setRepository(event.currentTarget.value)} /></label>
      <label>Review title<input value={title} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
      <button type="button" onClick={() => run(actions.exportHandoff(), 'Exported developer handoff.')}>Export handoff</button>
      <button type="button" onClick={() => run(actions.diagnostics.recovery().then((state) => state.active ? actions.diagnostics.resetRecovery() : Promise.resolve(state)), 'Crash recovery checked.')}>Recovery</button>
      <button type="button" onClick={() => run(actions.diagnostics.consent().then((state) => { setDiagnostics(state.user); return state; }), `Diagnostics: ${diagnostics}.`)}>Diagnostics consent</button>
      <button type="button" onClick={() => run(actions.diagnostics.export(), 'Exported diagnostics.')}>Export diagnostics</button>
      <button type="button" onClick={() => run(actions.diagnostics.delete(), 'Deleted diagnostics.')}>Delete diagnostics</button>
    </section> : null}
  </div>;
}
