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
  readonly target?: SpatialTargetInput;
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
  build, revisionId, readiness, frame, onFrameLoad, targeting, target, onTargetPointerDown,
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
      </div>
      <div className="preview-device" data-targeting={targeting || undefined}>
        {build ? <iframe className="preview-frame" ref={frame} title="Generated React preview frame" src={build.url} onLoad={onFrameLoad} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" /> : <div className="preview-frame preview-frame--loading" role="status">Preparing the secure preview…</div>}
        {targeting ? (
          <button className="preview-target-layer" aria-label="Select a spatial change target in the preview" type="button" onPointerDown={onTargetPointerDown} onPointerUp={onTargetPointerUp} onPointerCancel={onTargetPointerCancel} onClick={onTargetClick} />
        ) : null}
        {target ? <span className="preview-target" aria-hidden="true" style={{ left: `${target.x * 100}%`, top: `${target.y * 100}%`, width: `${(target.width ?? 0.02) * 100}%`, height: `${(target.height ?? 0.02) * 100}%` }} /> : null}
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
