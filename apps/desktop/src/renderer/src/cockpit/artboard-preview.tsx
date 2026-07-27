import { NodeToolbar, Position } from '@xyflow/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { PreviewSurfaceProps } from './preview-surface';
import { safeDesignerNotice } from '../presentation-error';
import {
  artifactCommentAffordancesVisible,
  formatThreadAuthor,
  formatThreadTimestamp
} from './comment-thread-navigation';

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

export interface FigmaCommentThreadProps {
  readonly presenting: boolean;
  readonly onAskAiFromThread: (threadId: string) => void;
  readonly onInsertAiMention: () => void;
  readonly threadIndex: number;
  readonly threadCount: number;
  readonly onNavigateThread: (direction: -1 | 1) => void;
  readonly onShowAllThreads: () => void;
  /** Clears the transient target and any open artifact thread from a blank-artifact click. */
  readonly onClearArtifactSelection: () => void;
}

/**
 * The conversation itself is deliberately independent from the active iframe.
 * Canvas reference artboards use this exact control when a global review rail
 * focuses a different screen, so replies, resolution, keyboard submit, and AI
 * handoff never silently turn into a second, reduced comment implementation.
 */
export interface ArtifactThreadCardProps extends FigmaCommentThreadProps {
  readonly selectedThread: NonNullable<ArtboardPreviewProps['selectedThread']>;
  readonly replyBody: string;
  readonly threadAction: NonNullable<ArtboardPreviewProps['threadAction']>;
  readonly threadStatus: string;
  readonly onReplyBodyChange: NonNullable<ArtboardPreviewProps['onReplyBodyChange']>;
  readonly onReplyThread: NonNullable<ArtboardPreviewProps['onReplyThread']>;
  readonly onResolveThread: NonNullable<ArtboardPreviewProps['onResolveThread']>;
  readonly onCloseThread: NonNullable<ArtboardPreviewProps['onCloseThread']>;
  readonly inert?: boolean;
  /** Re-focuses the conversation when an already-selected pin is activated again. */
  readonly focusRequest?: number;
}

export function ArtifactThreadCard({
  selectedThread,
  replyBody,
  threadAction,
  threadStatus,
  onReplyBodyChange,
  onReplyThread,
  onResolveThread,
  onCloseThread,
  inert,
  focusRequest,
  onAskAiFromThread,
  onInsertAiMention,
  threadIndex,
  threadCount,
  onNavigateThread,
  onShowAllThreads
}: ArtifactThreadCardProps) {
  const card = useRef<HTMLElement | null>(null);
  useEffect(() => {
    requestAnimationFrame(() => card.current?.querySelector<HTMLButtonElement>('button')?.focus());
  }, [focusRequest, selectedThread]);
  const submitReplyShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      !(event.metaKey || event.ctrlKey) ||
      event.key !== 'Enter' ||
      threadAction !== 'idle' ||
      selectedThread.status === 'resolved' ||
      !replyBody.trim()
    )
      return;
    event.preventDefault();
    void onReplyThread(selectedThread.id, replyBody);
  };
  return (
    <aside
      className="spatial-thread-card"
      ref={card}
      role="dialog"
      aria-modal="false"
      aria-label={`Review thread from ${formatThreadAuthor(selectedThread.author)}`}
      inert={inert || undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <header>
        <span>
          <strong>
            {selectedThread.status === 'resolved' ? 'Resolved review' : 'Stakeholder review'}
          </strong>
          <small>
            {formatThreadAuthor(selectedThread.author)} ·{' '}
            {formatThreadTimestamp(selectedThread.createdAt)} · {selectedThread.replies.length}{' '}
            {selectedThread.replies.length === 1 ? 'reply' : 'replies'}
          </small>
        </span>
        <button type="button" aria-label="Close selected review thread" onClick={onCloseThread}>
          ×
        </button>
      </header>
      <p className="spatial-thread-card__body">{selectedThread.body}</p>
      {threadStatus ? (
        <p className="spatial-thread-card__status" role="status" aria-live="polite">
          {safeDesignerNotice(
            threadStatus,
            'Thread status is unavailable. Try the review action again.'
          )}
        </p>
      ) : null}
      {selectedThread.replies.map((reply) => (
        <p className="spatial-thread-card__reply" key={reply.id}>
          <strong>{formatThreadAuthor(reply.author)}</strong>{' '}
          <time>{formatThreadTimestamp(reply.createdAt)}</time> {reply.body}
        </p>
      ))}
      <label>
        Reply
        <textarea
          aria-label="Reply to stakeholder thread"
          disabled={threadAction !== 'idle'}
          placeholder="Reply to this thread…"
          value={replyBody}
          onChange={(event) => onReplyBodyChange(event.currentTarget.value)}
          onKeyDown={submitReplyShortcut}
        />
      </label>
      <button
        className="spatial-thread-card__mention-ai"
        type="button"
        disabled={threadAction !== 'idle' || selectedThread.status === 'resolved'}
        onClick={onInsertAiMention}
      >
        Insert @AI mention
      </button>
      <p className="shortcut-hint">⌘/Ctrl + Enter replies · Escape closes this thread.</p>
      <footer>
        <button
          type="button"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          disabled={
            threadAction !== 'idle' || selectedThread.status === 'resolved' || !replyBody.trim()
          }
          onClick={() => void onReplyThread(selectedThread.id, replyBody)}
        >
          {threadAction === 'replying' ? 'Replying…' : 'Reply'}
        </button>
        <button
          type="button"
          disabled={threadAction !== 'idle'}
          onClick={() => onAskAiFromThread(selectedThread.id)}
        >
          Ask AI
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
      <nav className="spatial-thread-card__navigation" aria-label="Review thread navigation">
        <button type="button" disabled={threadCount < 2} onClick={() => onNavigateThread(-1)}>
          Previous
        </button>
        <span>
          {threadIndex + 1} / {threadCount}
        </span>
        <button type="button" disabled={threadCount < 2} onClick={() => onNavigateThread(1)}>
          Next
        </button>
        <button type="button" onClick={onShowAllThreads}>
          All threads
        </button>
      </nav>
    </aside>
  );
}

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
  onCloseThread,
  presenting,
  onAskAiFromThread,
  onInsertAiMention,
  threadIndex,
  threadCount,
  onNavigateThread,
  onShowAllThreads,
  onClearArtifactSelection
}: ArtboardPreviewProps & FigmaCommentThreadProps) {
  const commentsVisible = artifactCommentAffordancesVisible(presenting);
  const [threadFocusRequest, setThreadFocusRequest] = useState(0);
  return (
    <section
      className="artboard-preview"
      data-targeting={targeting || undefined}
      data-target-mode={targetMode}
      data-preview-state={build ? 'ready' : 'loading'}
      aria-label="Compiled React artboard"
    >
      <div
        className="preview-artifact-content"
        onPointerDown={(event) => {
          if (!targeting && event.target === event.currentTarget) onClearArtifactSelection();
        }}
      >
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
        {!commentsVisible ? null : targeting ? (
          <button
            className="preview-target-layer nodrag nopan"
            data-canvas-overlay-interaction
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
        {commentsVisible && aiTarget ? (
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
        {commentsVisible && reviewTarget ? (
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
        {commentsVisible
          ? pins.map((pin) => (
              <button
                key={pin.id}
                className="preview-pin nodrag nopan"
                data-canvas-overlay-interaction
                data-review-thread-id={pin.id}
                type="button"
                inert={targeting || undefined}
                aria-pressed={selectedPinId === pin.id}
                aria-label={`Select artifact pin marker: ${pin.label}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectPin(pin.id, event.currentTarget);
                  setThreadFocusRequest((current) => current + 1);
                }}
                style={{
                  left: `${pin.anchor.x * 100}%`,
                  top: `${pin.anchor.y * 100}%`
                }}
              >
                <span aria-hidden="true">•</span>
                <span className="preview-pin__label">{pin.label}</span>
              </button>
            ))
          : null}
        {commentsVisible && selectedThread ? (
          <NodeToolbar
            align={selectedThread.anchor.y > 0.52 ? 'end' : 'start'}
            className="artboard-preview artifact-conversation-toolbar nodrag nopan nowheel"
            data-canvas-overlay-interaction
            data-review-anchor-horizontal={selectedThread.anchor.x > 0.56 ? 'right' : 'left'}
            data-review-anchor-vertical={selectedThread.anchor.y > 0.52 ? 'bottom' : 'top'}
            data-screen-space-overlay="review-thread"
            isVisible
            // NodeToolbar is portaled and screen-space sized. A negative
            // width-plus-gutter offset docks the 320px card inside the opposite
            // artboard edge with enough inset for narrow canvas viewports.
            offset={-370}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            position={selectedThread.anchor.x > 0.56 ? Position.Left : Position.Right}
          >
            <ArtifactThreadCard
              selectedThread={selectedThread}
              replyBody={replyBody}
              threadAction={threadAction}
              threadStatus={threadStatus}
              onReplyBodyChange={onReplyBodyChange}
              onReplyThread={onReplyThread}
              onResolveThread={onResolveThread}
              onCloseThread={onCloseThread}
              inert={targeting}
              focusRequest={threadFocusRequest}
              presenting={presenting}
              onAskAiFromThread={onAskAiFromThread}
              onInsertAiMention={onInsertAiMention}
              threadIndex={threadIndex}
              threadCount={threadCount}
              onNavigateThread={onNavigateThread}
              onShowAllThreads={onShowAllThreads}
              onClearArtifactSelection={onClearArtifactSelection}
            />
          </NodeToolbar>
        ) : null}
      </div>
    </section>
  );
}
