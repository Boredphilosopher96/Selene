import { NodeToolbar, Position } from '@xyflow/react';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent
} from 'react';

import type { SpatialTargetInput } from '../../../shared/designer-api';
import {
  PREVIEW_CANVAS_GESTURE_DELTA_LIMIT,
  PREVIEW_CANVAS_GESTURE_EVENT,
  previewCanvasGesture,
  type PreviewMappedElementTelemetrySelection
} from '../../../shared/preview-channel';
import type { PreviewSurfaceProps } from './preview-surface';
import { safeDesignerNotice } from '../presentation-error';
import { constrainedArtifactDimension, keyboardArtifactDimension } from './artifact-resize';
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
  /** Clears only the ephemeral artifact selection from a blank canvas click. */
  readonly onClearArtifactSelection: () => void;
}

export interface ArtifactSelectionProps {
  /**
   * One transient selection shared by review, AI, and inspect. It is never a
   * durable comment or request on its own.
   */
  readonly artifactSelection?: {
    readonly anchor: SpatialTargetInput;
  };
  /**
   * Temporarily raises the shared selection plane above durable pins after an
   * explicit Select on canvas action. This is one neutral selection intent,
   * never an AI- or review-specific mode.
   */
  readonly selectionPlanePriority: boolean;
  readonly canInspectArtifactSelection: boolean;
  readonly onArtifactSelectionAction: (action: 'comment' | 'ask-ai' | 'inspect' | 'clear') => void;
}

export interface ArtifactDirectManipulationProps {
  readonly selectedElement?: PreviewMappedElementTelemetrySelection;
  readonly onResizeSelectedElement: (input: {
    readonly nodeId: string;
    readonly revisionId: string;
    readonly property: 'width' | 'height';
    readonly value: number;
  }) => Promise<Readonly<{ applied: boolean; message: string }>>;
  readonly onMoveSelectedElement: (input: {
    readonly nodeId: string;
    readonly revisionId: string;
    readonly deltaX: number;
    readonly deltaY: number;
  }) => Promise<Readonly<{ applied: boolean; message: string }>>;
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
  onClearArtifactSelection,
  artifactSelection,
  selectionPlanePriority,
  canInspectArtifactSelection,
  onArtifactSelectionAction,
  selectedElement,
  onResizeSelectedElement,
  onMoveSelectedElement
}: ArtboardPreviewProps &
  FigmaCommentThreadProps &
  ArtifactSelectionProps &
  ArtifactDirectManipulationProps) {
  const commentsVisible = artifactCommentAffordancesVisible(presenting);
  const [threadFocusRequest, setThreadFocusRequest] = useState(0);
  const [resizeDraft, setResizeDraft] = useState<Readonly<{ width: number; height: number }>>();
  const [resizeBusy, setResizeBusy] = useState<'width' | 'height'>();
  const [resizeActive, setResizeActive] = useState<'width' | 'height'>();
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveActive, setMoveActive] = useState(false);
  const [moveOffset, setMoveOffset] = useState({ left: 0, top: 0 });
  const [resizeStatus, setResizeStatus] = useState<string>();
  const resizeGesture = useRef<
    | {
        readonly pointerId: number;
        readonly property: 'width' | 'height';
        readonly startClient: number;
        readonly startValue: number;
        readonly scale: number;
        readonly handle: HTMLButtonElement;
        readonly cleanup: () => void;
        currentValue: number;
      }
    | undefined
  >(undefined);
  const moveGesture = useRef<
    | {
        readonly pointerId: number;
        readonly startClientX: number;
        readonly startClientY: number;
        readonly scale: number;
        readonly handle: HTMLButtonElement;
        readonly cleanup: () => void;
        currentOffset: { left: number; top: number };
      }
    | undefined
  >(undefined);
  const selectedElementIdentity = selectedElement
    ? `${selectedElement.nodeId}:${selectedElement.revisionId}`
    : undefined;
  useEffect(() => {
    const gesture = resizeGesture.current;
    gesture?.cleanup();
    if (gesture?.handle.hasPointerCapture(gesture.pointerId))
      gesture.handle.releasePointerCapture(gesture.pointerId);
    resizeGesture.current = undefined;
    setResizeDraft(
      selectedElement
        ? {
            width: constrainedArtifactDimension(selectedElement.values.width, false),
            height: constrainedArtifactDimension(selectedElement.values.height, false)
          }
        : undefined
    );
    setResizeBusy(undefined);
    setResizeActive(undefined);
    setMoveBusy(false);
    setMoveActive(false);
    setMoveOffset({ left: 0, top: 0 });
    setResizeStatus(undefined);
    return () => {
      const current = resizeGesture.current;
      current?.cleanup();
      if (current?.handle.hasPointerCapture(current.pointerId))
        current.handle.releasePointerCapture(current.pointerId);
      resizeGesture.current = undefined;
      const moving = moveGesture.current;
      moving?.cleanup();
      if (moving?.handle.hasPointerCapture(moving.pointerId))
        moving.handle.releasePointerCapture(moving.pointerId);
      moveGesture.current = undefined;
    };
  }, [selectedElementIdentity, selectedElement?.values.width, selectedElement?.values.height]);

  const commitResize = async (property: 'width' | 'height', value: number) => {
    if (!selectedElement || resizeBusy) return;
    setResizeBusy(property);
    setResizeStatus(`Applying ${property}…`);
    try {
      const outcome = await onResizeSelectedElement({
        nodeId: selectedElement.nodeId,
        revisionId: selectedElement.revisionId,
        property,
        value
      });
      setResizeStatus(outcome.message);
      if (!outcome.applied)
        setResizeDraft({
          width: constrainedArtifactDimension(selectedElement.values.width, false),
          height: constrainedArtifactDimension(selectedElement.values.height, false)
        });
    } catch {
      setResizeDraft({
        width: constrainedArtifactDimension(selectedElement.values.width, false),
        height: constrainedArtifactDimension(selectedElement.values.height, false)
      });
      setResizeStatus('Resize was not applied. Use Frame controls in Inspect and try again.');
    } finally {
      setResizeBusy(undefined);
    }
  };

  const beginResize =
    (property: 'width' | 'height') => (event: PointerEvent<HTMLButtonElement>) => {
      if (!selectedElement || !resizeDraft || resizeBusy) return;
      event.preventDefault();
      event.stopPropagation();
      const surface = event.currentTarget.closest<HTMLElement>('.preview-artifact-content');
      const bounds = surface?.getBoundingClientRect();
      const logicalSize =
        property === 'width' ? (surface?.clientWidth ?? 0) : (surface?.clientHeight ?? 0);
      const paintedSize = property === 'width' ? (bounds?.width ?? 0) : (bounds?.height ?? 0);
      const scale = logicalSize > 0 && paintedSize > 0 ? paintedSize / logicalSize : 1;
      const handle = event.currentTarget;
      const initialDraft = resizeDraft;
      let gesture: NonNullable<typeof resizeGesture.current>;
      const update = (clientX: number, clientY: number, precise: boolean) => {
        if (resizeGesture.current !== gesture) return;
        const currentClient = gesture.property === 'width' ? clientX : clientY;
        const value = constrainedArtifactDimension(
          gesture.startValue + (currentClient - gesture.startClient) / gesture.scale,
          !precise
        );
        gesture.currentValue = value;
        setResizeDraft((current) =>
          current ? { ...current, [gesture.property]: value } : current
        );
        setResizeStatus(`${gesture.property === 'width' ? 'W' : 'H'} ${value}px`);
      };
      const complete = () => {
        if (resizeGesture.current !== gesture) return;
        gesture.cleanup();
        if (handle.hasPointerCapture(gesture.pointerId))
          handle.releasePointerCapture(gesture.pointerId);
        resizeGesture.current = undefined;
        setResizeActive(undefined);
        if (gesture.currentValue === gesture.startValue) {
          setResizeStatus('Resize cancelled — the source value is unchanged.');
          return;
        }
        void commitResize(gesture.property, gesture.currentValue);
      };
      const move = (moveEvent: globalThis.PointerEvent) => {
        if (resizeGesture.current !== gesture || moveEvent.pointerId !== gesture.pointerId) return;
        moveEvent.preventDefault();
        moveEvent.stopImmediatePropagation();
        update(moveEvent.clientX, moveEvent.clientY, moveEvent.altKey);
      };
      const mouseMove = (moveEvent: globalThis.MouseEvent) => {
        if (resizeGesture.current !== gesture) return;
        moveEvent.preventDefault();
        moveEvent.stopImmediatePropagation();
        update(moveEvent.clientX, moveEvent.clientY, moveEvent.altKey);
      };
      const finish = (finishEvent: globalThis.PointerEvent) => {
        if (resizeGesture.current !== gesture || finishEvent.pointerId !== gesture.pointerId)
          return;
        finishEvent.preventDefault();
        finishEvent.stopImmediatePropagation();
        complete();
      };
      const mouseFinish = (finishEvent: globalThis.MouseEvent) => {
        if (resizeGesture.current !== gesture) return;
        finishEvent.preventDefault();
        finishEvent.stopImmediatePropagation();
        complete();
      };
      const cancel = (cancelEvent: globalThis.PointerEvent) => {
        if (resizeGesture.current !== gesture || cancelEvent.pointerId !== gesture.pointerId)
          return;
        cancelEvent.preventDefault();
        cancelEvent.stopImmediatePropagation();
        gesture.cleanup();
        if (handle.hasPointerCapture(gesture.pointerId))
          handle.releasePointerCapture(gesture.pointerId);
        resizeGesture.current = undefined;
        setResizeActive(undefined);
        setResizeDraft(initialDraft);
        setResizeStatus('Resize cancelled — the React artifact was not changed.');
      };
      gesture = {
        pointerId: event.pointerId,
        property,
        startClient: property === 'width' ? event.clientX : event.clientY,
        startValue: initialDraft[property],
        scale,
        handle,
        cleanup: () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', finish);
          handle.removeEventListener('pointercancel', cancel);
          handle.removeEventListener('lostpointercapture', cancel);
          window.removeEventListener('mousemove', mouseMove, true);
          window.removeEventListener('mouseup', mouseFinish, true);
        },
        currentValue: initialDraft[property]
      };
      resizeGesture.current = gesture;
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', cancel);
      handle.addEventListener('lostpointercapture', cancel);
      window.addEventListener('mousemove', mouseMove, true);
      window.addEventListener('mouseup', mouseFinish, true);
      handle.focus();
      handle.setPointerCapture(event.pointerId);
      setResizeActive(property);
      setResizeStatus(`Drag to resize ${property}; hold Option for precise values.`);
    };

  const cancelResize = (event?: PointerEvent<HTMLElement>) => {
    const gesture = resizeGesture.current;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    gesture?.cleanup();
    if (gesture?.handle.hasPointerCapture(gesture.pointerId))
      gesture.handle.releasePointerCapture(gesture.pointerId);
    resizeGesture.current = undefined;
    setResizeActive(undefined);
    if (selectedElement)
      setResizeDraft({
        width: constrainedArtifactDimension(selectedElement.values.width, false),
        height: constrainedArtifactDimension(selectedElement.values.height, false)
      });
    setResizeStatus('Resize cancelled — the React artifact was not changed.');
  };

  const resizeKeyDown =
    (property: 'width' | 'height') => (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!resizeDraft || resizeBusy || event.repeat) return;
      const decrease = property === 'width' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
      const increase =
        property === 'width' ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelResize();
        return;
      }
      if (!decrease && !increase) return;
      event.preventDefault();
      event.stopPropagation();
      const value = keyboardArtifactDimension(
        resizeDraft[property],
        decrease ? -1 : 1,
        event.shiftKey
      );
      setResizeDraft((current) => (current ? { ...current, [property]: value } : current));
      void commitResize(property, value);
    };

  const commitMove = async (offset: { readonly left: number; readonly top: number }) => {
    if (!selectedElement || moveBusy || resizeBusy) return;
    setMoveBusy(true);
    setResizeStatus('Applying position…');
    try {
      const outcome = await onMoveSelectedElement({
        nodeId: selectedElement.nodeId,
        revisionId: selectedElement.revisionId,
        deltaX: offset.left,
        deltaY: offset.top
      });
      setResizeStatus(outcome.message);
      if (!outcome.applied) setMoveOffset({ left: 0, top: 0 });
    } catch {
      setMoveOffset({ left: 0, top: 0 });
      setResizeStatus('Move was not applied. Only authored absolute or fixed left/top can move.');
    } finally {
      setMoveBusy(false);
    }
  };

  const beginMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!selectedElement || moveBusy || resizeBusy) return;
    event.preventDefault();
    event.stopPropagation();
    const surface = event.currentTarget.closest<HTMLElement>('.preview-artifact-content');
    const bounds = surface?.getBoundingClientRect();
    const scale =
      (surface?.clientWidth ?? 0) > 0 && (bounds?.width ?? 0) > 0
        ? (bounds?.width ?? 0) / (surface?.clientWidth ?? 1)
        : 1;
    const handle = event.currentTarget;
    let gesture: NonNullable<typeof moveGesture.current>;
    const update = (clientX: number, clientY: number, precise: boolean) => {
      if (moveGesture.current !== gesture) return;
      const snap = precise ? 1 : 8;
      gesture.currentOffset = {
        left: Math.round((clientX - gesture.startClientX) / gesture.scale / snap) * snap,
        top: Math.round((clientY - gesture.startClientY) / gesture.scale / snap) * snap
      };
      setMoveOffset(gesture.currentOffset);
      setResizeStatus(
        `Move ${gesture.currentOffset.left >= 0 ? '+' : ''}${gesture.currentOffset.left}, ${gesture.currentOffset.top >= 0 ? '+' : ''}${gesture.currentOffset.top}px`
      );
    };
    const cancel = () => {
      if (moveGesture.current !== gesture) return;
      gesture.cleanup();
      if (handle.hasPointerCapture(gesture.pointerId))
        handle.releasePointerCapture(gesture.pointerId);
      moveGesture.current = undefined;
      setMoveActive(false);
      setMoveOffset({ left: 0, top: 0 });
      setResizeStatus('Move cancelled — the React artifact was not changed.');
    };
    const complete = () => {
      if (moveGesture.current !== gesture) return;
      gesture.cleanup();
      if (handle.hasPointerCapture(gesture.pointerId))
        handle.releasePointerCapture(gesture.pointerId);
      moveGesture.current = undefined;
      setMoveActive(false);
      if (gesture.currentOffset.left === 0 && gesture.currentOffset.top === 0) {
        setResizeStatus('Move cancelled — the source position is unchanged.');
        return;
      }
      void commitMove(gesture.currentOffset);
    };
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveGesture.current !== gesture || moveEvent.pointerId !== gesture.pointerId) return;
      moveEvent.preventDefault();
      moveEvent.stopImmediatePropagation();
      update(moveEvent.clientX, moveEvent.clientY, moveEvent.altKey);
    };
    const mouseMove = (moveEvent: globalThis.MouseEvent) => {
      if (moveGesture.current !== gesture) return;
      moveEvent.preventDefault();
      moveEvent.stopImmediatePropagation();
      update(moveEvent.clientX, moveEvent.clientY, moveEvent.altKey);
    };
    const finish = (finishEvent: globalThis.PointerEvent) => {
      if (moveGesture.current !== gesture || finishEvent.pointerId !== gesture.pointerId) return;
      finishEvent.preventDefault();
      finishEvent.stopImmediatePropagation();
      complete();
    };
    const mouseFinish = (finishEvent: globalThis.MouseEvent) => {
      if (moveGesture.current !== gesture) return;
      finishEvent.preventDefault();
      finishEvent.stopImmediatePropagation();
      complete();
    };
    const keyDown = (keyEvent: globalThis.KeyboardEvent) => {
      if (moveGesture.current !== gesture || keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      keyEvent.stopImmediatePropagation();
      cancel();
    };
    gesture = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      scale,
      handle,
      cleanup: () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', cancel);
        handle.removeEventListener('lostpointercapture', cancel);
        window.removeEventListener('mousemove', mouseMove, true);
        window.removeEventListener('mouseup', mouseFinish, true);
        window.removeEventListener('keydown', keyDown, true);
      },
      currentOffset: { left: 0, top: 0 }
    };
    moveGesture.current = gesture;
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', cancel);
    handle.addEventListener('lostpointercapture', cancel);
    window.addEventListener('mousemove', mouseMove, true);
    window.addEventListener('mouseup', mouseFinish, true);
    window.addEventListener('keydown', keyDown, true);
    handle.focus();
    handle.setPointerCapture(event.pointerId);
    setMoveOffset({ left: 0, top: 0 });
    setMoveActive(true);
    setResizeStatus('Drag to move; hold Option for precise values.');
  };

  const moveKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!selectedElement || moveBusy || resizeBusy || event.repeat) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setMoveOffset({ left: 0, top: 0 });
      setResizeStatus('Move cancelled — the source position is unchanged.');
      return;
    }
    const amount = event.shiftKey ? 8 : 1;
    const offset =
      event.key === 'ArrowLeft'
        ? { left: -amount, top: 0 }
        : event.key === 'ArrowRight'
          ? { left: amount, top: 0 }
          : event.key === 'ArrowUp'
            ? { left: 0, top: -amount }
            : event.key === 'ArrowDown'
              ? { left: 0, top: amount }
              : undefined;
    if (offset === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    setMoveOffset(offset);
    void commitMove(offset);
  };

  const forwardSelectionWheelToCanvas = (event: WheelEvent<HTMLElement>) => {
    if (!event.nativeEvent.isTrusted) return;
    const surface = event.currentTarget.closest<HTMLElement>('.preview-artifact-content');
    const bounds = surface?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const unit =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? Math.max(bounds.width, bounds.height)
          : 1;
    const boundedDelta = (value: number) =>
      Math.max(
        -PREVIEW_CANVAS_GESTURE_DELTA_LIMIT,
        Math.min(PREVIEW_CANVAS_GESTURE_DELTA_LIMIT, value * unit)
      );
    const gesture = previewCanvasGesture({
      gesture: event.ctrlKey ? 'zoom' : 'pan',
      deltaX: boundedDelta(event.deltaX),
      deltaY: boundedDelta(event.deltaY),
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
    });
    if (!gesture || (gesture.deltaX === 0 && gesture.deltaY === 0)) return;
    event.preventDefault();
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent(PREVIEW_CANVAS_GESTURE_EVENT, { detail: gesture }));
  };

  return (
    <section
      className="artboard-preview"
      data-preview-state={build ? 'ready' : 'loading'}
      aria-label="Compiled React artboard"
    >
      <div
        className="preview-artifact-content"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onClearArtifactSelection();
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
        {resizeActive || moveActive ? (
          <div
            className="artifact-resize-shield nodrag nopan nowheel"
            data-canvas-overlay-interaction
            data-resize-axis={moveActive ? 'move' : resizeActive}
            aria-hidden="true"
          />
        ) : null}
        {!commentsVisible || artifactSelection ? null : (
          <button
            className="preview-target-layer nodrag nopan"
            data-canvas-overlay-interaction
            data-selection-plane-priority={selectionPlanePriority || undefined}
            aria-label="Select a point or region on the artifact"
            type="button"
            onPointerDown={onTargetPointerDown}
            onPointerUp={onTargetPointerUp}
            onPointerCancel={onTargetPointerCancel}
            onClick={onTargetClick}
          />
        )}
        {commentsVisible && artifactSelection ? (
          <>
            <span
              className="artifact-selection-marker"
              aria-label="Selected artifact area"
              style={{
                left: `${artifactSelection.anchor.x * 100}%`,
                top: `${artifactSelection.anchor.y * 100}%`,
                width: `${(artifactSelection.anchor.width ?? 0.02) * 100}%`,
                height: `${(artifactSelection.anchor.height ?? 0.02) * 100}%`
              }}
            />
            <div
              className="artifact-selection-popover nodrag nopan nowheel"
              data-canvas-overlay-interaction
              role="toolbar"
              aria-label="Selected artifact actions"
              data-selection-horizontal={artifactSelection.anchor.x > 0.62 ? 'left' : 'right'}
              data-selection-vertical={artifactSelection.anchor.y > 0.54 ? 'above' : 'below'}
              style={{
                left: `${artifactSelection.anchor.x * 100}%`,
                top: `${artifactSelection.anchor.y * 100}%`
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <button type="button" onClick={() => onArtifactSelectionAction('comment')}>
                Comment
              </button>
              <button type="button" onClick={() => onArtifactSelectionAction('ask-ai')}>
                Ask AI
              </button>
              <button
                type="button"
                disabled={!canInspectArtifactSelection}
                title={
                  canInspectArtifactSelection
                    ? 'Open the trusted source inspection context'
                    : 'Inspect is available for mapped preview elements only'
                }
                onClick={() => onArtifactSelectionAction('inspect')}
              >
                Inspect
              </button>
              <button type="button" onClick={() => onArtifactSelectionAction('clear')}>
                Clear
              </button>
            </div>
          </>
        ) : null}
        {commentsVisible &&
        !artifactSelection &&
        selectedElement &&
        selectedElement.values.left !== undefined &&
        selectedElement.values.top !== undefined &&
        resizeDraft ? (
          <div
            className="artifact-direct-selection nodrag nopan"
            data-canvas-overlay-interaction
            data-resizing={resizeBusy || moveBusy ? 'true' : undefined}
            data-moving={moveActive || moveBusy ? 'true' : undefined}
            role="group"
            aria-label={`Selected React element, ${resizeDraft.width} by ${resizeDraft.height} pixels`}
            style={{
              left: `${selectedElement.values.left + moveOffset.left}px`,
              top: `${selectedElement.values.top + moveOffset.top}px`,
              width: `${resizeDraft.width}px`,
              height: `${resizeDraft.height}px`
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onWheel={forwardSelectionWheelToCanvas}
          >
            <span className="artifact-direct-selection__dimensions" aria-hidden="true">
              {resizeDraft.width} × {resizeDraft.height}
            </span>
            <button
              className="artifact-move-handle"
              type="button"
              aria-label="Move selected element"
              aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown"
              disabled={resizeBusy !== undefined || moveBusy}
              onPointerDown={beginMove}
              onKeyDown={moveKeyDown}
            >
              <span className="artifact-move-handle__label">Move selected element</span>
            </button>
            <button
              className="artifact-resize-handle artifact-resize-handle--width"
              type="button"
              aria-label={`Resize selected element width, currently ${resizeDraft.width} pixels`}
              aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"
              disabled={resizeBusy !== undefined}
              onPointerDown={beginResize('width')}
              onKeyDown={resizeKeyDown('width')}
            />
            <button
              className="artifact-resize-handle artifact-resize-handle--height"
              type="button"
              aria-label={`Resize selected element height, currently ${resizeDraft.height} pixels`}
              aria-keyshortcuts="ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown"
              disabled={resizeBusy !== undefined}
              onPointerDown={beginResize('height')}
              onKeyDown={resizeKeyDown('height')}
            />
            {resizeStatus ? (
              <output
                className="artifact-direct-selection__status"
                role="status"
                aria-label="Direct manipulation status"
              >
                {resizeStatus}
              </output>
            ) : null}
          </div>
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
