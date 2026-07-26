import { useEffect, useRef, type KeyboardEvent } from 'react';

import type { PreviewSurfaceProps } from './preview-surface';

export type ArtboardPreviewProps = Pick<
  PreviewSurfaceProps,
  | 'build'
  | 'frame'
  | 'onFrameLoad'
  | 'onFrameError'
  | 'targeting'
  | 'targetMode'
  | 'aiTarget'
  | 'reviewTarget'
  | 'onTargetPointerDown'
  | 'onTargetPointerUp'
  | 'onTargetPointerCancel'
  | 'onTargetClick'
  | 'pins'
  | 'selectedPinId'
  | 'onSelectPin'
  | 'selectedThread'
  | 'replyBody'
  | 'threadAction'
  | 'threadStatus'
  | 'onReplyBodyChange'
  | 'onReplyThread'
  | 'onResolveThread'
  | 'onCloseThread'
>;

/**
 * The trusted compiled artifact without device chrome or a second pan/zoom
 * surface. The unified workspace owns canvas navigation; this component owns
 * only the iframe and spatial collaboration affordances bound to that frame.
 */
export function ArtboardPreview({
  build,
  frame,
  onFrameLoad,
  onFrameError,
  targeting,
  targetMode,
  aiTarget,
  reviewTarget,
  onTargetPointerDown,
  onTargetPointerUp,
  onTargetPointerCancel,
  onTargetClick,
  pins,
  selectedPinId,
  onSelectPin,
  selectedThread,
  replyBody,
  threadAction,
  threadStatus,
  onReplyBodyChange,
  onReplyThread,
  onResolveThread,
  onCloseThread
}: ArtboardPreviewProps) {
  const card = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (selectedThread)
      requestAnimationFrame(() =>
        card.current?.querySelector<HTMLButtonElement>('button')?.focus()
      );
  }, [selectedThread]);
  const submitReplyShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const thread = selectedThread;
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      !(event.metaKey || event.ctrlKey) ||
      event.key !== 'Enter' ||
      threadAction !== 'idle' ||
      thread === undefined ||
      thread.status === 'resolved' ||
      !replyBody.trim()
    )
      return;
    event.preventDefault();
    void onReplyThread(thread.id, replyBody);
  };

  return (
    <section
      className="artboard-preview"
      data-targeting={targeting || undefined}
      data-target-mode={targetMode}
      data-preview-state={build ? 'ready' : 'loading'}
      aria-label="Compiled React artboard"
    >
      <div className="preview-artifact-content">
        {build ? (
          <iframe
            className="preview-frame"
            ref={frame}
            title="Generated React preview frame"
            src={build.url}
            onLoad={(event) => onFrameLoad(event.currentTarget)}
            onError={(event) => onFrameError(event.currentTarget)}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="preview-frame preview-frame--loading" role="status">
            Preparing the secure preview…
          </div>
        )}
        {targeting ? (
          <button
            className="preview-target-layer"
            data-target-mode={targetMode}
            aria-label={
              targetMode === 'review'
                ? 'Select a stakeholder review location in the rendered artifact'
                : 'Select an AI change target in the rendered artifact'
            }
            type="button"
            onPointerDown={onTargetPointerDown}
            onPointerUp={onTargetPointerUp}
            onPointerCancel={onTargetPointerCancel}
            onClick={onTargetClick}
          />
        ) : null}
        {aiTarget ? (
          <span
            className="preview-target preview-target--ai"
            aria-label="Saved AI target"
            style={{
              left: `${aiTarget.x * 100}%`,
              top: `${aiTarget.y * 100}%`,
              width: `${(aiTarget.width ?? 0.02) * 100}%`,
              height: `${(aiTarget.height ?? 0.02) * 100}%`
            }}
          />
        ) : null}
        {reviewTarget ? (
          <span
            className="preview-target preview-target--review"
            aria-label="Saved stakeholder review target"
            style={{
              left: `${reviewTarget.x * 100}%`,
              top: `${reviewTarget.y * 100}%`,
              width: `${(reviewTarget.width ?? 0.02) * 100}%`,
              height: `${(reviewTarget.height ?? 0.02) * 100}%`
            }}
          />
        ) : null}
        {pins.map((pin) => (
          <button
            key={pin.id}
            className="preview-pin"
            type="button"
            inert={targeting || undefined}
            aria-pressed={selectedPinId === pin.id}
            aria-label={`Select artifact pin marker: ${pin.label}`}
            onClick={(event) => onSelectPin(pin.id, event.currentTarget)}
            style={{
              left: `${pin.anchor.x * 100}%`,
              top: `${pin.anchor.y * 100}%`
            }}
          >
            <span aria-hidden="true">•</span>
            <span className="preview-pin__label">{pin.label}</span>
          </button>
        ))}
        {selectedThread ? (
          <aside
            className="spatial-thread-card"
            ref={card}
            role="dialog"
            aria-modal="false"
            aria-label={`Review thread from ${selectedThread.author}`}
            inert={targeting || undefined}
            style={{
              left: `${Math.min(72, Math.max(4, selectedThread.anchor.x * 100 + 2))}%`,
              top: `${Math.min(72, Math.max(4, selectedThread.anchor.y * 100 + 2))}%`
            }}
          >
            <header>
              <span>
                <strong>
                  {selectedThread.status === 'resolved' ? 'Resolved review' : 'Stakeholder review'}
                </strong>
                <small>
                  {selectedThread.author} · {selectedThread.replies.length} replies
                </small>
              </span>
              <button
                type="button"
                aria-label="Close selected review thread"
                onClick={onCloseThread}
              >
                ×
              </button>
            </header>
            <p>{selectedThread.body}</p>
            {threadStatus ? (
              <p className="spatial-thread-card__status" role="status" aria-live="polite">
                {threadStatus}
              </p>
            ) : null}
            {selectedThread.replies.map((reply) => (
              <p className="spatial-thread-card__reply" key={reply.id}>
                <strong>{reply.author}</strong> {reply.body}
              </p>
            ))}
            <label>
              Reply
              <textarea
                disabled={threadAction !== 'idle'}
                value={replyBody}
                onChange={(event) => onReplyBodyChange(event.currentTarget.value)}
                onKeyDown={submitReplyShortcut}
              />
            </label>
            <p className="shortcut-hint">⌘/Ctrl + Enter replies · Escape closes this thread.</p>
            <footer>
              <button
                type="button"
                aria-keyshortcuts="Meta+Enter Control+Enter"
                disabled={
                  threadAction !== 'idle' ||
                  selectedThread.status === 'resolved' ||
                  !replyBody.trim()
                }
                onClick={() => void onReplyThread(selectedThread.id, replyBody)}
              >
                {threadAction === 'replying' ? 'Replying…' : 'Reply'}
              </button>
              <button
                type="button"
                disabled={threadAction !== 'idle'}
                onClick={() =>
                  void onResolveThread(selectedThread.id, selectedThread.status !== 'resolved')
                }
              >
                {threadAction === 'resolving'
                  ? 'Saving…'
                  : selectedThread.status === 'resolved'
                    ? 'Reopen'
                    : 'Resolve'}
              </button>
            </footer>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
