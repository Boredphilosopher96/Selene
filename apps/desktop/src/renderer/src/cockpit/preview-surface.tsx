import { useEffect, useRef, type PointerEvent, type RefObject } from 'react';

import type { ReviewThread, SpatialTargetInput } from '../../../shared/designer-api';

export interface PreviewBuild {
  readonly url: string;
  readonly revisionId: string;
}

interface ArtifactPin {
  readonly id: string;
  readonly label: string;
  readonly anchor: SpatialTargetInput;
}

interface PreviewSurfaceProps {
  readonly build?: PreviewBuild;
  readonly revisionId: string;
  readonly readiness: string;
  readonly frame: RefObject<HTMLIFrameElement | null>;
  readonly onFrameLoad: () => void;
  readonly targeting: boolean;
  readonly targetMode: 'idle' | 'ai' | 'review';
  readonly aiTarget?: SpatialTargetInput;
  readonly reviewTarget?: SpatialTargetInput;
  readonly onTargetPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  readonly onTargetPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  readonly onTargetPointerCancel: () => void;
  readonly onTargetClick: (event: PointerEvent<HTMLButtonElement>) => void;
  readonly pins: readonly ArtifactPin[];
  readonly selectedPinId?: string;
  readonly onSelectPin: (id: string, invoking: HTMLButtonElement) => void;
  readonly selectedThread?: ReviewThread;
  readonly replyBody: string;
  readonly onReplyBodyChange: (body: string) => void;
  readonly onReplyThread: (id: string, body: string) => Promise<void>;
  readonly onResolveThread: (id: string, resolved: boolean) => void;
  readonly onCloseThread: () => void;
}

/** Sandboxed compiled preview plus trusted-host spatial targeting and pin affordances. */
export function PreviewSurface({
  build, revisionId, readiness, frame, onFrameLoad, targeting, targetMode, aiTarget, reviewTarget, onTargetPointerDown,
  onTargetPointerUp, onTargetPointerCancel, onTargetClick, pins, selectedPinId, onSelectPin,
  selectedThread, replyBody, onReplyBodyChange, onReplyThread, onResolveThread, onCloseThread
}: PreviewSurfaceProps) {
  const card = useRef<HTMLElement | null>(null);
  useEffect(() => { if (selectedThread) requestAnimationFrame(() => card.current?.querySelector<HTMLButtonElement>('button')?.focus()); }, [selectedThread?.id]);
  return (
    <section className="preview-pane">
      <div className="preview-toolbar">
        <span>Compiled React artifact</span>
        <code>{revisionId}</code>
        <span>{readiness}</span>
        <span>{targetMode === 'ai' ? 'AI targeting' : targetMode === 'review' ? 'Review targeting' : aiTarget && reviewTarget ? 'AI and review targets saved' : aiTarget ? 'AI target saved' : reviewTarget ? 'Review target saved' : 'Selection idle'}</span>
      </div>
      <div className="preview-device" data-targeting={targeting || undefined} data-target-mode={targetMode}>
        {build ? <iframe className="preview-frame" ref={frame} title="Generated React preview frame" src={build.url} onLoad={onFrameLoad} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" /> : <div className="preview-frame preview-frame--loading" role="status">Preparing the secure preview…</div>}
        {targeting ? (
          <button className="preview-target-layer" aria-label={targetMode === 'review' ? 'Select a stakeholder review location in the preview' : 'Select an AI change target in the preview'} type="button" onPointerDown={onTargetPointerDown} onPointerUp={onTargetPointerUp} onPointerCancel={onTargetPointerCancel} onClick={onTargetClick} />
        ) : null}
        {aiTarget ? <span className="preview-target preview-target--ai" aria-label="Saved AI target" style={{ left: `${aiTarget.x * 100}%`, top: `${aiTarget.y * 100}%`, width: `${(aiTarget.width ?? 0.02) * 100}%`, height: `${(aiTarget.height ?? 0.02) * 100}%` }} /> : null}
        {reviewTarget ? <span className="preview-target preview-target--review" aria-label="Saved stakeholder review target" style={{ left: `${reviewTarget.x * 100}%`, top: `${reviewTarget.y * 100}%`, width: `${(reviewTarget.width ?? 0.02) * 100}%`, height: `${(reviewTarget.height ?? 0.02) * 100}%` }} /> : null}
        {pins.map((pin) => <button key={pin.id} className="preview-pin" type="button" aria-pressed={selectedPinId === pin.id} aria-label={`Select artifact pin ${pin.label}`} onClick={(event) => onSelectPin(pin.id, event.currentTarget)} style={{ left: `${pin.anchor.x * 100}%`, top: `${pin.anchor.y * 100}%` }}>•</button>)}
        {selectedThread ? <aside className="spatial-thread-card" ref={card} aria-label={`Review thread from ${selectedThread.author}`} style={{ left: `${Math.min(72, Math.max(4, selectedThread.anchor.x * 100 + 2))}%`, top: `${Math.min(72, Math.max(4, selectedThread.anchor.y * 100 + 2))}%` }}>
          <header><strong>{selectedThread.status === 'resolved' ? 'Resolved review' : 'Stakeholder review'}</strong><button type="button" aria-label="Close selected review thread" onClick={onCloseThread}>×</button></header>
          <p>{selectedThread.body}</p>
          {selectedThread.replies.map((reply) => <p className="spatial-thread-card__reply" key={reply.id}><strong>{reply.author}</strong> {reply.body}</p>)}
          <label>Reply<textarea value={replyBody} onChange={(event) => onReplyBodyChange(event.currentTarget.value)} /></label>
          <footer><button type="button" disabled={selectedThread.status === 'resolved' || !replyBody.trim()} onClick={() => void onReplyThread(selectedThread.id, replyBody).catch(() => undefined)}>Reply</button><button type="button" onClick={() => onResolveThread(selectedThread.id, selectedThread.status !== 'resolved')}>{selectedThread.status === 'resolved' ? 'Reopen' : 'Resolve'}</button></footer>
        </aside> : null}
      </div>
    </section>
  );
}
