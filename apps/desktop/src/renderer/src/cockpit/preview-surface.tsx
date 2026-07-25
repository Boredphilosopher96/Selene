import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

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
  readonly threadAction: 'idle' | 'replying' | 'resolving';
  readonly threadStatus: string;
  readonly onReplyBodyChange: (body: string) => void;
  readonly onReplyThread: (id: string, body: string) => Promise<void>;
  readonly onResolveThread: (id: string, resolved: boolean) => Promise<void>;
  readonly onCloseThread: () => void;
}

const previewDeviceById = {
  desktop: { label: 'Desktop', width: '100%' },
  tablet: { label: 'Tablet', width: '768px' },
  phone: { label: 'Phone', width: '390px' }
};
type PreviewDevice = keyof typeof previewDeviceById;
const previewDevices: readonly PreviewDevice[] = ['desktop', 'tablet', 'phone'];

function nextPreviewDevice(current: PreviewDevice, key: string): PreviewDevice | undefined {
  if (key === 'Home') return 'desktop';
  if (key === 'End') return 'phone';
  if (key === 'ArrowLeft' || key === 'ArrowUp') return current === 'desktop' ? 'phone' : current === 'tablet' ? 'desktop' : 'tablet';
  if (key === 'ArrowRight' || key === 'ArrowDown') return current === 'desktop' ? 'tablet' : current === 'tablet' ? 'phone' : 'desktop';
  return undefined;
}

/** Sandboxed compiled preview plus trusted-host spatial targeting and pin affordances. */
export function PreviewSurface({
  build, revisionId, readiness, frame, onFrameLoad, targeting, targetMode, aiTarget, reviewTarget, onTargetPointerDown,
  onTargetPointerUp, onTargetPointerCancel, onTargetClick, pins, selectedPinId, onSelectPin,
  selectedThread, replyBody, threadAction, threadStatus, onReplyBodyChange, onReplyThread, onResolveThread, onCloseThread
}: PreviewSurfaceProps) {
  const card = useRef<HTMLElement | null>(null);
  const deviceControls = useRef(new Map<PreviewDevice, HTMLButtonElement>());
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>('desktop');
  const selectedPreviewDevice = previewDeviceById[previewDevice];
  useEffect(() => { if (selectedThread) requestAnimationFrame(() => card.current?.querySelector<HTMLButtonElement>('button')?.focus()); }, [selectedThread?.id]);
  const submitReplyShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const thread = selectedThread;
    if (event.defaultPrevented || event.nativeEvent.isComposing || !(event.metaKey || event.ctrlKey) || event.key !== 'Enter' || threadAction !== 'idle' || thread === undefined || thread.status === 'resolved' || !replyBody.trim()) return;
    event.preventDefault();
    void onReplyThread(thread.id, replyBody);
  };
  return (
    <section className="preview-pane">
      <div className="preview-toolbar" aria-label="Preview status">
        <span className="preview-toolbar__identity"><strong>Compiled preview</strong><code>{revisionId}</code></span>
        <span className="preview-toolbar__badges"><span className="preview-toolbar__badge">{readiness}</span><span className="preview-toolbar__badge is-secure">Sandboxed</span></span>
        <span className="preview-device-controls" role="radiogroup" aria-label="Rendered artifact width">
          {previewDevices.map((device) => <button key={device} type="button" role="radio" aria-checked={previewDevice === device} tabIndex={previewDevice === device ? 0 : -1} ref={(element) => { if (element) deviceControls.current.set(device, element); else deviceControls.current.delete(device); }} onClick={() => setPreviewDevice(device)} onKeyDown={(event) => { const next = nextPreviewDevice(previewDevice, event.key); if (next === undefined) return; event.preventDefault(); setPreviewDevice(next); requestAnimationFrame(() => deviceControls.current.get(next)?.focus()); }}>{previewDeviceById[device].label}</button>)}
        </span>
        <span className="preview-toolbar__selection" aria-live="polite">{targetMode === 'ai' ? 'Picking AI target' : targetMode === 'review' ? 'Picking review location' : aiTarget && reviewTarget ? 'AI and review targets saved' : aiTarget ? 'AI target saved' : reviewTarget ? 'Review target saved' : 'Ready for selection'}</span>
      </div>
      <div className="preview-device" data-targeting={targeting || undefined} data-target-mode={targetMode} data-preview-state={build ? 'ready' : 'loading'}>
        <div className="preview-device__chrome" aria-hidden="true"><span className="preview-device__camera" /><span>{selectedPreviewDevice.label} preview</span><span>Secure frame</span></div>
        <div className="preview-device__viewport">
          <div className="preview-artifact-stage" data-preview-device={previewDevice} style={{ '--preview-artifact-width': selectedPreviewDevice.width } as CSSProperties}>
            {build ? <iframe className="preview-frame" ref={frame} title="Generated React preview frame" src={build.url} onLoad={onFrameLoad} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" /> : <div className="preview-frame preview-frame--loading" role="status">Preparing the secure preview…</div>}
            {targeting ? (
              <button className="preview-target-layer" aria-label={targetMode === 'review' ? 'Select a stakeholder review location in the rendered artifact' : 'Select an AI change target in the rendered artifact'} type="button" onPointerDown={onTargetPointerDown} onPointerUp={onTargetPointerUp} onPointerCancel={onTargetPointerCancel} onClick={onTargetClick} />
            ) : null}
            {aiTarget ? <span className="preview-target preview-target--ai" aria-label="Saved AI target" style={{ left: `${aiTarget.x * 100}%`, top: `${aiTarget.y * 100}%`, width: `${(aiTarget.width ?? 0.02) * 100}%`, height: `${(aiTarget.height ?? 0.02) * 100}%` }} /> : null}
            {reviewTarget ? <span className="preview-target preview-target--review" aria-label="Saved stakeholder review target" style={{ left: `${reviewTarget.x * 100}%`, top: `${reviewTarget.y * 100}%`, width: `${(reviewTarget.width ?? 0.02) * 100}%`, height: `${(reviewTarget.height ?? 0.02) * 100}%` }} /> : null}
            {pins.map((pin) => <button key={pin.id} className="preview-pin" type="button" aria-pressed={selectedPinId === pin.id} aria-label={`Select artifact pin ${pin.label}`} onClick={(event) => onSelectPin(pin.id, event.currentTarget)} style={{ left: `${pin.anchor.x * 100}%`, top: `${pin.anchor.y * 100}%` }}>•</button>)}
            {selectedThread ? <aside className="spatial-thread-card" ref={card} role="dialog" aria-modal="false" aria-label={`Review thread from ${selectedThread.author}`} style={{ left: `${Math.min(72, Math.max(4, selectedThread.anchor.x * 100 + 2))}%`, top: `${Math.min(72, Math.max(4, selectedThread.anchor.y * 100 + 2))}%` }}>
          <header><span><strong>{selectedThread.status === 'resolved' ? 'Resolved review' : 'Stakeholder review'}</strong><small>{selectedThread.author} · {selectedThread.replies.length} replies</small></span><button type="button" aria-label="Close selected review thread" onClick={onCloseThread}>×</button></header>
          <p>{selectedThread.body}</p>
          {threadStatus ? <p className="spatial-thread-card__status" role="status" aria-live="polite">{threadStatus}</p> : null}
          {selectedThread.replies.map((reply) => <p className="spatial-thread-card__reply" key={reply.id}><strong>{reply.author}</strong> {reply.body}</p>)}
          <label>Reply<textarea disabled={threadAction !== 'idle'} value={replyBody} onChange={(event) => onReplyBodyChange(event.currentTarget.value)} onKeyDown={submitReplyShortcut} /></label>
          <p className="shortcut-hint">⌘/Ctrl + Enter replies · Escape closes this thread.</p>
          <footer><button type="button" aria-keyshortcuts="Meta+Enter Control+Enter" disabled={threadAction !== 'idle' || selectedThread.status === 'resolved' || !replyBody.trim()} onClick={() => void onReplyThread(selectedThread.id, replyBody)}>{threadAction === 'replying' ? 'Replying…' : 'Reply'}</button><button type="button" disabled={threadAction !== 'idle'} onClick={() => void onResolveThread(selectedThread.id, selectedThread.status !== 'resolved')}>{threadAction === 'resolving' ? 'Saving…' : selectedThread.status === 'resolved' ? 'Reopen' : 'Resolve'}</button></footer>
            </aside> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
