import { NodeToolbar, Position } from '@xyflow/react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent
} from 'react';
import { createPortal } from 'react-dom';

import type { SpatialTargetInput } from '../../../shared/designer-api';
import {
  PREVIEW_CANVAS_GESTURE_DELTA_LIMIT,
  PREVIEW_CANVAS_GESTURE_EVENT,
  previewCanvasGesture,
  type PreviewMappedElementTelemetrySelection
} from '../../../shared/preview-channel';
import type { PreviewSurfaceProps } from './preview-surface';
import { safeDesignerNotice } from '../presentation-error';
import {
  artifactAlignItemsValues,
  artifactGapPixels,
  artifactJustifyContentValues,
  nextArtifactGap,
  supportsArtifactAutoLayout,
  type ArtifactAutoLayoutProperty
} from './artifact-auto-layout';
import { artifactMove, type ArtifactMoveAlignment } from './artifact-movement';
import {
  constrainedArtifactDimension,
  keyboardArtifactDimension,
  type ArtifactDimensionConstraints
} from './artifact-resize';
import { artifactSpacing } from './artifact-spacing';
import {
  artifactCommentAffordancesVisible,
  formatThreadAuthor,
  formatThreadTimestamp
} from './comment-thread-navigation';
import { artifactToolbarScreenPosition } from './artifact-toolbar-position';

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
  readonly onSelectedElementContextAction: (
    action: 'comment' | 'ask-ai' | 'inspect',
    selection: PreviewMappedElementTelemetrySelection
  ) => void;
  readonly onBeginSelectedElementTextEdit: (input: {
    readonly nodeId: string;
    readonly revisionId: string;
  }) => Promise<
    | Readonly<{
        available: true;
        capabilityId: string;
        currentContent: string;
        maxLength: number;
      }>
    | Readonly<{ available: false; message: string }>
  >;
  readonly onUpdateSelectedElementText: (input: {
    readonly nodeId: string;
    readonly revisionId: string;
    readonly capabilityId: string;
    readonly content: string;
  }) => Promise<Readonly<{ applied: boolean; message: string }>>;
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
  readonly onReorderSelectedElement: (input: {
    readonly nodeId: string;
    readonly revisionId: string;
    readonly targetNodeId: string;
  }) => Promise<Readonly<{ applied: boolean; message: string }>>;
  readonly onUpdateSelectedElementLayout: (input: {
    readonly nodeId: string;
    readonly revisionId: string;
    readonly property: ArtifactAutoLayoutProperty;
    readonly value: string;
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
  onSelectedElementContextAction,
  onBeginSelectedElementTextEdit,
  onUpdateSelectedElementText,
  onResizeSelectedElement,
  onMoveSelectedElement,
  onReorderSelectedElement,
  onUpdateSelectedElementLayout
}: ArtboardPreviewProps &
  FigmaCommentThreadProps &
  ArtifactSelectionProps &
  ArtifactDirectManipulationProps) {
  const commentsVisible = artifactCommentAffordancesVisible(presenting);
  const [threadFocusRequest, setThreadFocusRequest] = useState(0);
  const [resizeDraft, setResizeDraft] = useState<Readonly<{ width: number; height: number }>>();
  const [resizeBusy, setResizeBusy] = useState<'width' | 'height'>();
  const [resizeActive, setResizeActive] = useState<'width' | 'height'>();
  const [layoutBusy, setLayoutBusy] = useState<ArtifactAutoLayoutProperty>();
  const [textEditBusy, setTextEditBusy] = useState(false);
  const [textEditSession, setTextEditSession] = useState<
    Readonly<{
      capabilityId: string;
      originalContent: string;
      draft: string;
      maxLength: number;
    }>
  >();
  const [moveBusy, setMoveBusy] = useState(false);
  const [structureBusy, setStructureBusy] = useState(false);
  const [structureTargetNodeId, setStructureTargetNodeId] = useState<string>();
  const [structureTargetState, setStructureTargetState] = useState<'candidate' | 'invalid'>();
  const [moveActive, setMoveActive] = useState(false);
  const [moveOffset, setMoveOffset] = useState({ left: 0, top: 0 });
  const [moveAlignment, setMoveAlignment] = useState<ArtifactMoveAlignment>({});
  const [resizeStatus, setResizeStatus] = useState<string>();
  const directSelection = useRef<HTMLDivElement>(null);
  const directToolbar = useRef<HTMLDivElement>(null);
  const [directToolbarPortal, setDirectToolbarPortal] = useState<HTMLElement>();
  const [directToolbarPosition, setDirectToolbarPosition] = useState<
    Readonly<{ key: string; left: number; top: number; vertical: 'above' | 'below' }>
  >({ key: '', left: 0, top: 0, vertical: 'below' });
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
        readonly semantic: boolean;
        targetNodeId?: string;
      }
    | undefined
  >(undefined);
  const moveHandle = useRef<HTMLButtonElement>(null);
  const selectedElementIdentity = selectedElement
    ? `${selectedElement.nodeId}:${selectedElement.revisionId}`
    : undefined;
  const resizeConstraints = (property: 'width' | 'height'): ArtifactDimensionConstraints => {
    const values = selectedElement?.values;
    const minimum = property === 'width' ? values?.minWidth : values?.minHeight;
    const maximum = property === 'width' ? values?.maxWidth : values?.maxHeight;
    const parent = property === 'width' ? values?.parentWidth : values?.parentHeight;
    return {
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
      ...(parent === undefined ? {} : { parent })
    };
  };
  useEffect(() => {
    const gesture = resizeGesture.current;
    gesture?.cleanup();
    if (gesture?.handle.hasPointerCapture(gesture.pointerId))
      gesture.handle.releasePointerCapture(gesture.pointerId);
    resizeGesture.current = undefined;
    setResizeDraft(
      selectedElement
        ? {
            width: constrainedArtifactDimension(
              selectedElement.values.width,
              false,
              resizeConstraints('width')
            ),
            height: constrainedArtifactDimension(
              selectedElement.values.height,
              false,
              resizeConstraints('height')
            )
          }
        : undefined
    );
    setResizeBusy(undefined);
    setResizeActive(undefined);
    setLayoutBusy(undefined);
    setTextEditBusy(false);
    setTextEditSession(undefined);
    setMoveBusy(false);
    setStructureBusy(false);
    setStructureTargetNodeId(undefined);
    setStructureTargetState(undefined);
    setMoveActive(false);
    setMoveOffset({ left: 0, top: 0 });
    setMoveAlignment({});
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
  }, [
    selectedElementIdentity,
    selectedElement?.values.width,
    selectedElement?.values.height,
    selectedElement?.values.minWidth,
    selectedElement?.values.minHeight,
    selectedElement?.values.maxWidth,
    selectedElement?.values.maxHeight,
    selectedElement?.values.parentWidth,
    selectedElement?.values.parentHeight
  ]);

  const commitResize = async (property: 'width' | 'height', value: number) => {
    if (
      !selectedElement ||
      resizeBusy ||
      layoutBusy ||
      textEditBusy ||
      textEditSession ||
      moveBusy ||
      structureBusy
    )
      return;
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
          width: constrainedArtifactDimension(
            selectedElement.values.width,
            false,
            resizeConstraints('width')
          ),
          height: constrainedArtifactDimension(
            selectedElement.values.height,
            false,
            resizeConstraints('height')
          )
        });
    } catch {
      setResizeDraft({
        width: constrainedArtifactDimension(
          selectedElement.values.width,
          false,
          resizeConstraints('width')
        ),
        height: constrainedArtifactDimension(
          selectedElement.values.height,
          false,
          resizeConstraints('height')
        )
      });
      setResizeStatus('Resize was not applied. Use Frame controls in Inspect and try again.');
    } finally {
      setResizeBusy(undefined);
    }
  };

  const commitAutoLayout = async (property: ArtifactAutoLayoutProperty, value: string) => {
    if (
      !selectedElement ||
      layoutBusy !== undefined ||
      resizeBusy ||
      textEditBusy ||
      moveBusy ||
      structureBusy
    )
      return;
    setLayoutBusy(property);
    setResizeStatus(`Applying ${property}…`);
    try {
      const outcome = await onUpdateSelectedElementLayout({
        nodeId: selectedElement.nodeId,
        revisionId: selectedElement.revisionId,
        property,
        value
      });
      setResizeStatus(outcome.message);
    } catch {
      setResizeStatus(
        'Auto layout was not changed. Refresh the selection or use Auto layout in Inspect.'
      );
    } finally {
      setLayoutBusy(undefined);
    }
  };

  const beginTextEdit = async () => {
    if (
      !selectedElement ||
      textEditBusy ||
      resizeBusy ||
      layoutBusy !== undefined ||
      moveBusy ||
      structureBusy
    )
      return;
    setTextEditBusy(true);
    setResizeStatus('Checking source-backed text…');
    try {
      const outcome = await onBeginSelectedElementTextEdit({
        nodeId: selectedElement.nodeId,
        revisionId: selectedElement.revisionId
      });
      if (!outcome.available) {
        setTextEditSession(undefined);
        setResizeStatus(outcome.message);
        return;
      }
      setTextEditSession({
        capabilityId: outcome.capabilityId,
        originalContent: outcome.currentContent,
        draft: outcome.currentContent,
        maxLength: outcome.maxLength
      });
      setResizeStatus('Edit the literal React text, then save or cancel.');
    } catch {
      setTextEditSession(undefined);
      setResizeStatus('Direct text editing is unavailable. Open Inspect or ask AI instead.');
    } finally {
      setTextEditBusy(false);
    }
  };

  const commitTextEdit = async () => {
    if (!selectedElement || !textEditSession || textEditBusy) return;
    setTextEditBusy(true);
    setResizeStatus('Applying text…');
    try {
      const outcome = await onUpdateSelectedElementText({
        nodeId: selectedElement.nodeId,
        revisionId: selectedElement.revisionId,
        capabilityId: textEditSession.capabilityId,
        content: textEditSession.draft
      });
      setResizeStatus(outcome.message);
      if (outcome.applied) setTextEditSession(undefined);
    } catch {
      setResizeStatus('Text was not changed. Refresh the selection or use Text in Inspect.');
    } finally {
      setTextEditBusy(false);
    }
  };

  const beginResize =
    (property: 'width' | 'height') => (event: PointerEvent<HTMLButtonElement>) => {
      if (
        !selectedElement ||
        !resizeDraft ||
        resizeBusy ||
        layoutBusy ||
        textEditBusy ||
        textEditSession ||
        moveBusy ||
        structureBusy
      )
        return;
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
          !precise,
          resizeConstraints(gesture.property)
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
        width: constrainedArtifactDimension(
          selectedElement.values.width,
          false,
          resizeConstraints('width')
        ),
        height: constrainedArtifactDimension(
          selectedElement.values.height,
          false,
          resizeConstraints('height')
        )
      });
    setResizeStatus('Resize cancelled — the React artifact was not changed.');
  };

  const resizeKeyDown =
    (property: 'width' | 'height') => (event: KeyboardEvent<HTMLButtonElement>) => {
      if (
        !resizeDraft ||
        resizeBusy ||
        layoutBusy ||
        textEditBusy ||
        textEditSession ||
        moveBusy ||
        structureBusy ||
        event.repeat
      )
        return;
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
        event.shiftKey,
        resizeConstraints(property)
      );
      setResizeDraft((current) => (current ? { ...current, [property]: value } : current));
      void commitResize(property, value);
    };

  const commitMove = async (offset: { readonly left: number; readonly top: number }) => {
    if (
      !selectedElement ||
      moveBusy ||
      resizeBusy ||
      layoutBusy ||
      textEditBusy ||
      textEditSession ||
      structureBusy
    )
      return;
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
      if (!outcome.applied) {
        setMoveOffset({ left: 0, top: 0 });
        setMoveAlignment({});
      }
    } catch {
      setMoveOffset({ left: 0, top: 0 });
      setMoveAlignment({});
      setResizeStatus('Move was not applied. Only authored absolute or fixed left/top can move.');
    } finally {
      setMoveBusy(false);
    }
  };

  const beginMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (
      !selectedElement ||
      moveBusy ||
      resizeBusy ||
      layoutBusy ||
      textEditBusy ||
      textEditSession ||
      structureBusy
    )
      return;
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
      if (gesture.semantic) {
        const target = (selectedElement.values.alignmentTargets ?? [])
          .map((candidate) => {
            const x = (clientX - (bounds?.left ?? clientX)) / gesture.scale;
            const y = (clientY - (bounds?.top ?? clientY)) / gesture.scale;
            const horizontal = Math.max(
              candidate.left - x,
              0,
              x - (candidate.left + candidate.width)
            );
            const vertical = Math.max(candidate.top - y, 0, y - (candidate.top + candidate.height));
            return { candidate, distance: Math.hypot(horizontal, vertical) };
          })
          .filter((candidate) => candidate.distance <= 48)
          .sort(
            (left, right) =>
              left.distance - right.distance ||
              left.candidate.nodeId.localeCompare(right.candidate.nodeId)
          )[0]?.candidate;
        if (target === undefined) delete gesture.targetNodeId;
        else gesture.targetNodeId = target.nodeId;
        setStructureTargetNodeId(target?.nodeId);
        setStructureTargetState(target ? 'candidate' : undefined);
        setResizeStatus(
          target
            ? 'Release to insert before the highlighted mapped element.'
            : 'Drop on a highlighted mapped element to reorder or reparent.'
        );
        return;
      }
      const movement = artifactMove({
        deltaX: (clientX - gesture.startClientX) / gesture.scale,
        deltaY: (clientY - gesture.startClientY) / gesture.scale,
        precise,
        element: {
          left: selectedElement.values.left ?? 0,
          top: selectedElement.values.top ?? 0,
          width: resizeDraft?.width ?? selectedElement.values.width,
          height: resizeDraft?.height ?? selectedElement.values.height
        },
        artboard: {
          width: surface?.clientWidth ?? 0,
          height: surface?.clientHeight ?? 0
        },
        ...(selectedElement.values.alignmentTargets
          ? { alignmentTargets: selectedElement.values.alignmentTargets }
          : undefined)
      });
      gesture.currentOffset = movement.offset;
      setMoveOffset(gesture.currentOffset);
      setMoveAlignment(movement.alignment);
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
      setMoveAlignment({});
      setStructureTargetNodeId(undefined);
      setStructureTargetState(undefined);
      setResizeStatus('Move cancelled — the React artifact was not changed.');
    };
    const complete = () => {
      if (moveGesture.current !== gesture) return;
      gesture.cleanup();
      if (handle.hasPointerCapture(gesture.pointerId))
        handle.releasePointerCapture(gesture.pointerId);
      moveGesture.current = undefined;
      setMoveActive(false);
      setMoveAlignment({});
      if (gesture.semantic) {
        const targetNodeId = gesture.targetNodeId;
        if (targetNodeId === undefined) {
          setStructureTargetNodeId(undefined);
          setStructureTargetState(undefined);
          setResizeStatus('Structure move cancelled — no compatible mapped drop target.');
          return;
        }
        setStructureBusy(true);
        void onReorderSelectedElement({
          nodeId: selectedElement.nodeId,
          revisionId: selectedElement.revisionId,
          targetNodeId
        })
          .then((outcome) => {
            setResizeStatus(outcome.message);
            if (outcome.applied) {
              setStructureTargetNodeId(undefined);
              setStructureTargetState(undefined);
            } else setStructureTargetState('invalid');
          })
          .catch(() => {
            setStructureTargetState('invalid');
            setResizeStatus('Structure edit was not applied.');
          })
          .finally(() => setStructureBusy(false));
        return;
      }
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
      currentOffset: { left: 0, top: 0 },
      semantic: event.shiftKey
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
    setMoveAlignment({});
    setStructureTargetNodeId(undefined);
    setStructureTargetState(undefined);
    setMoveActive(true);
    setResizeStatus(
      event.shiftKey
        ? 'Drag over a mapped element to reorder or reparent; Escape cancels.'
        : 'Drag to move; hold Option for precise values.'
    );
  };

  const moveKeyDown = (event: globalThis.KeyboardEvent) => {
    if (
      !selectedElement ||
      moveBusy ||
      resizeBusy ||
      layoutBusy ||
      textEditBusy ||
      textEditSession ||
      structureBusy ||
      event.repeat
    )
      return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setMoveOffset({ left: 0, top: 0 });
      setMoveAlignment({});
      setResizeStatus('Move cancelled — the source position is unchanged.');
      return;
    }
    const direction =
      event.key === 'ArrowLeft'
        ? { x: -1, y: 0 }
        : event.key === 'ArrowRight'
          ? { x: 1, y: 0 }
          : event.key === 'ArrowUp'
            ? { x: 0, y: -1 }
            : event.key === 'ArrowDown'
              ? { x: 0, y: 1 }
              : undefined;
    if (event.altKey && direction !== undefined) {
      const selectedCenter = {
        x: (selectedElement.values.left ?? 0) + selectedElement.values.width / 2,
        y: (selectedElement.values.top ?? 0) + selectedElement.values.height / 2
      };
      const target = (selectedElement.values.alignmentTargets ?? [])
        .filter((candidate) => {
          const center = {
            x: candidate.left + candidate.width / 2,
            y: candidate.top + candidate.height / 2
          };
          return (
            (direction.x === 0 || (center.x - selectedCenter.x) * direction.x > 0) &&
            (direction.y === 0 || (center.y - selectedCenter.y) * direction.y > 0)
          );
        })
        .sort((left, right) => {
          const leftDistance = Math.hypot(
            left.left + left.width / 2 - selectedCenter.x,
            left.top + left.height / 2 - selectedCenter.y
          );
          const rightDistance = Math.hypot(
            right.left + right.width / 2 - selectedCenter.x,
            right.top + right.height / 2 - selectedCenter.y
          );
          return leftDistance - rightDistance || left.nodeId.localeCompare(right.nodeId);
        })[0];
      event.preventDefault();
      event.stopPropagation();
      if (target === undefined) {
        setStructureTargetNodeId(undefined);
        setStructureTargetState(undefined);
        setResizeStatus('No mapped insertion target is available in that direction.');
        return;
      }
      setStructureBusy(true);
      setStructureTargetNodeId(target.nodeId);
      setStructureTargetState('candidate');
      setResizeStatus('Applying semantic structure edit…');
      void onReorderSelectedElement({
        nodeId: selectedElement.nodeId,
        revisionId: selectedElement.revisionId,
        targetNodeId: target.nodeId
      })
        .then((outcome) => {
          setResizeStatus(outcome.message);
          if (outcome.applied) {
            setStructureTargetNodeId(undefined);
            setStructureTargetState(undefined);
          } else setStructureTargetState('invalid');
        })
        .catch(() => {
          setStructureTargetState('invalid');
          setResizeStatus('Structure edit was not applied.');
        })
        .finally(() => {
          setStructureBusy(false);
        });
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

  useEffect(() => {
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (document.activeElement !== moveHandle.current) return;
      moveKeyDown(event);
    };
    window.addEventListener('keydown', keyDown, true);
    return () => window.removeEventListener('keydown', keyDown, true);
  });

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

  const manipulationGuide =
    selectedElement &&
    selectedElement.values.left !== undefined &&
    selectedElement.values.top !== undefined &&
    resizeDraft &&
    (moveActive || resizeActive)
      ? {
          mode: moveActive ? ('move' as const) : (`resize-${resizeActive}` as const),
          left: selectedElement.values.left + moveOffset.left,
          top: selectedElement.values.top + moveOffset.top,
          width: resizeDraft.width,
          height: resizeDraft.height
        }
      : undefined;
  const spacingMeasurements =
    manipulationGuide?.mode === 'move'
      ? artifactSpacing(
          {
            left: manipulationGuide.left,
            top: manipulationGuide.top,
            width: manipulationGuide.width,
            height: manipulationGuide.height
          },
          selectedElement?.values.alignmentTargets ?? []
        )
      : [];
  const structureTarget = selectedElement?.values.alignmentTargets?.find(
    (target) => target.nodeId === structureTargetNodeId
  );
  const structureGhost =
    moveActive && moveGesture.current?.semantic === true && structureTarget && resizeDraft
      ? {
          left: structureTarget.left,
          top: structureTarget.top,
          width: resizeDraft.width,
          height: resizeDraft.height
        }
      : undefined;
  const autoLayoutAvailable =
    selectedElement !== undefined && supportsArtifactAutoLayout(selectedElement.values.display);
  const selectedGap = selectedElement?.values.gap ?? '';
  const selectedGapPixels = artifactGapPixels(selectedGap);
  const currentAlignItems = selectedElement?.values.alignItems;
  const selectedAlignItems = artifactAlignItemsValues.includes(
    currentAlignItems as (typeof artifactAlignItemsValues)[number]
  )
    ? currentAlignItems
    : '';
  const currentJustifyContent = selectedElement?.values.justifyContent;
  const selectedJustifyContent = artifactJustifyContentValues.includes(
    currentJustifyContent as (typeof artifactJustifyContentValues)[number]
  )
    ? currentJustifyContent
    : '';
  const directToolbarPositionKey = [
    selectedElement?.nodeId,
    selectedElement?.revisionId,
    selectedElement?.values.left,
    selectedElement?.values.top,
    selectedElement?.values.width,
    selectedElement?.values.height,
    textEditSession ? 'text-open' : 'text-closed',
    autoLayoutAvailable ? 'layout' : 'no-layout'
  ].join(':');
  const directToolbarPlaced = directToolbarPosition.key === directToolbarPositionKey;

  useLayoutEffect(() => {
    if (!commentsVisible || !selectedElement) {
      setDirectToolbarPortal(undefined);
      return;
    }
    const canvas = directSelection.current?.closest<HTMLElement>('.react-flow');
    if (canvas && canvas !== directToolbarPortal) setDirectToolbarPortal(canvas);
  }, [commentsVisible, directToolbarPortal, resizeDraft, selectedElement]);

  useLayoutEffect(() => {
    if (!commentsVisible || !selectedElement || !directToolbarPortal) return;
    let animationFrame = 0;
    const measure = () => {
      const toolbar = directToolbar.current;
      const selection = directSelection.current;
      if (!toolbar || !selection) return;
      const toolbarBounds = toolbar.getBoundingClientRect();
      const canvasBounds = directToolbarPortal.getBoundingClientRect();
      const selectionBounds = selection.getBoundingClientRect();
      const viewportLeft = Math.max(0, canvasBounds.left);
      const viewportTop = Math.max(0, canvasBounds.top);
      const viewportRight = Math.min(window.innerWidth, canvasBounds.right);
      const viewportBottom = Math.min(window.innerHeight, canvasBounds.bottom);
      const position = artifactToolbarScreenPosition(
        selectionBounds,
        { width: toolbarBounds.width, height: toolbarBounds.height },
        {
          left: viewportLeft,
          top: viewportTop,
          right: viewportRight,
          bottom: viewportBottom,
          width: Math.max(0, viewportRight - viewportLeft),
          height: Math.max(0, viewportBottom - viewportTop)
        }
      );
      const next = {
        key: directToolbarPositionKey,
        left: position.left - canvasBounds.left,
        top: position.top - canvasBounds.top,
        vertical: position.vertical
      } as const;
      setDirectToolbarPosition((current) =>
        current.key === next.key &&
        Math.abs(current.left - next.left) < 0.5 &&
        Math.abs(current.top - next.top) < 0.5 &&
        current.vertical === next.vertical
          ? current
          : next
      );
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(measure);
    };
    scheduleMeasure();
    const observer = new ResizeObserver(scheduleMeasure);
    if (directToolbar.current) observer.observe(directToolbar.current);
    if (directSelection.current) observer.observe(directSelection.current);
    observer.observe(directToolbarPortal);
    const viewport = directToolbarPortal.querySelector<HTMLElement>('.react-flow__viewport');
    const viewportObserver = new MutationObserver(scheduleMeasure);
    if (viewport)
      viewportObserver.observe(viewport, {
        attributeFilter: ['style'],
        attributes: true
      });
    window.addEventListener('resize', scheduleMeasure);
    window.addEventListener(PREVIEW_CANVAS_GESTURE_EVENT, scheduleMeasure);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      viewportObserver.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener(PREVIEW_CANVAS_GESTURE_EVENT, scheduleMeasure);
    };
  }, [commentsVisible, directToolbarPortal, directToolbarPositionKey, selectedElement]);

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
        {manipulationGuide ? (
          <div
            className="artifact-manipulation-guides"
            data-guide-mode={manipulationGuide.mode}
            data-move-x={manipulationGuide.mode === 'move' ? moveOffset.left : undefined}
            data-move-y={manipulationGuide.mode === 'move' ? moveOffset.top : undefined}
            aria-hidden="true"
            style={
              {
                '--artifact-guide-left': `${manipulationGuide.left}px`,
                '--artifact-guide-top': `${manipulationGuide.top}px`,
                '--artifact-guide-right': `${manipulationGuide.left + manipulationGuide.width}px`,
                '--artifact-guide-bottom': `${manipulationGuide.top + manipulationGuide.height}px`
              } as CSSProperties
            }
          >
            <span className="artifact-manipulation-guide artifact-manipulation-guide--left" />
            <span className="artifact-manipulation-guide artifact-manipulation-guide--right" />
            <span className="artifact-manipulation-guide artifact-manipulation-guide--top" />
            <span className="artifact-manipulation-guide artifact-manipulation-guide--bottom" />
            {moveAlignment.vertical ? (
              <span
                className="artifact-alignment-guide artifact-alignment-guide--vertical"
                data-alignment={moveAlignment.vertical.kind}
                data-alignment-source={moveAlignment.vertical.targetNodeId ? 'element' : 'artboard'}
                style={{ left: `${moveAlignment.vertical.position}px` }}
              />
            ) : null}
            {moveAlignment.horizontal ? (
              <span
                className="artifact-alignment-guide artifact-alignment-guide--horizontal"
                data-alignment={moveAlignment.horizontal.kind}
                data-alignment-source={
                  moveAlignment.horizontal.targetNodeId ? 'element' : 'artboard'
                }
                style={{ top: `${moveAlignment.horizontal.position}px` }}
              />
            ) : null}
            {spacingMeasurements.map((measurement) => (
              <span
                className={`artifact-spacing-guide artifact-spacing-guide--${measurement.axis}`}
                data-side={measurement.side}
                data-spacing={`${Math.round(measurement.length * 100) / 100}px`}
                key={`${measurement.axis}:${measurement.side}`}
                style={
                  measurement.axis === 'horizontal'
                    ? {
                        left: `${measurement.start}px`,
                        top: `${measurement.cross}px`,
                        width: `${measurement.length}px`
                      }
                    : {
                        left: `${measurement.cross}px`,
                        top: `${measurement.start}px`,
                        height: `${measurement.length}px`
                      }
                }
              >
                <b>{Math.round(measurement.length * 100) / 100}px</b>
              </span>
            ))}
            {structureTarget ? (
              <span
                className="artifact-structure-guide"
                aria-hidden="true"
                data-structure-target-state={structureTargetState ?? 'candidate'}
                style={{
                  left: `${structureTarget.left}px`,
                  top: `${structureTarget.top}px`,
                  width: `${structureTarget.width}px`,
                  height: `${structureTarget.height}px`
                }}
              >
                <span className="artifact-structure-guide__label">Insert before</span>
              </span>
            ) : null}
            {structureGhost ? (
              <span
                className="artifact-structure-ghost"
                aria-hidden="true"
                style={{
                  left: `${structureGhost.left}px`,
                  top: `${structureGhost.top}px`,
                  width: `${structureGhost.width}px`,
                  height: `${structureGhost.height}px`
                }}
              />
            ) : null}
            <span
              className="artifact-manipulation-guides__coordinate"
              style={{
                left: `${manipulationGuide.left}px`,
                top: `${manipulationGuide.top}px`
              }}
            >
              {manipulationGuide.mode === 'move'
                ? `X ${Math.round(manipulationGuide.left)} · Y ${Math.round(manipulationGuide.top)}`
                : manipulationGuide.mode === 'resize-width'
                  ? `W ${Math.round(manipulationGuide.width)}`
                  : `H ${Math.round(manipulationGuide.height)}`}
            </span>
          </div>
        ) : null}
        {structureTarget && structureTargetState === 'invalid' ? (
          <span
            className="artifact-structure-guide"
            aria-hidden="true"
            data-structure-target-state="invalid"
            style={{
              left: `${structureTarget.left}px`,
              top: `${structureTarget.top}px`,
              width: `${structureTarget.width}px`,
              height: `${structureTarget.height}px`
            }}
          >
            <span className="artifact-structure-guide__label">Not source-safe</span>
          </span>
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
        {commentsVisible && !artifactSelection && selectedElement && resizeDraft ? (
          <div
            className="artifact-direct-selection nodrag nopan"
            data-canvas-overlay-interaction
            data-resizing={
              resizeBusy || moveBusy || structureBusy || layoutBusy || textEditBusy
                ? 'true'
                : undefined
            }
            data-moving={moveActive || moveBusy ? 'true' : undefined}
            data-auto-layout={autoLayoutAvailable ? 'true' : undefined}
            ref={directSelection}
            role="group"
            aria-label={`Selected React element, ${resizeDraft.width} by ${resizeDraft.height} pixels`}
            style={{
              left: `${(selectedElement.values.left ?? 0) + moveOffset.left}px`,
              top: `${(selectedElement.values.top ?? 0) + moveOffset.top}px`,
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
              ref={moveHandle}
              className="artifact-move-handle"
              type="button"
              aria-label="Move selected element"
              aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
              disabled={
                resizeBusy !== undefined ||
                moveBusy ||
                structureBusy ||
                layoutBusy !== undefined ||
                textEditBusy ||
                textEditSession !== undefined
              }
              onPointerDown={beginMove}
            >
              <span className="artifact-move-handle__label">Move selected element</span>
            </button>
            <button
              className="artifact-resize-handle artifact-resize-handle--width"
              type="button"
              aria-label={`Resize selected element width, currently ${resizeDraft.width} pixels`}
              aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"
              disabled={
                resizeBusy !== undefined ||
                layoutBusy !== undefined ||
                textEditBusy ||
                textEditSession !== undefined
              }
              onPointerDown={beginResize('width')}
              onKeyDown={resizeKeyDown('width')}
            />
            <button
              className="artifact-resize-handle artifact-resize-handle--height"
              type="button"
              aria-label={`Resize selected element height, currently ${resizeDraft.height} pixels`}
              aria-keyshortcuts="ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown"
              disabled={
                resizeBusy !== undefined ||
                layoutBusy !== undefined ||
                textEditBusy ||
                textEditSession !== undefined
              }
              onPointerDown={beginResize('height')}
              onKeyDown={resizeKeyDown('height')}
            />
            {directToolbarPortal
              ? createPortal(
                  <div className="artboard-preview artifact-selection-toolbar-portal">
                    <div
                      className="artifact-selection-toolbar-stack"
                      data-auto-layout={autoLayoutAvailable ? 'true' : undefined}
                      data-position={directToolbarPlaced ? directToolbarPosition.vertical : 'below'}
                      ref={directToolbar}
                      style={{
                        left: `${directToolbarPosition.left}px`,
                        top: `${directToolbarPosition.top}px`,
                        visibility: directToolbarPlaced ? 'visible' : 'hidden'
                      }}
                    >
                      <div
                        className="artifact-selection-actions"
                        role="toolbar"
                        aria-label="Selected React element actions"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          disabled={
                            textEditBusy || layoutBusy !== undefined || resizeBusy !== undefined
                          }
                          onClick={() => onSelectedElementContextAction('comment', selectedElement)}
                        >
                          Comment
                        </button>
                        <button
                          type="button"
                          disabled={
                            textEditBusy || layoutBusy !== undefined || resizeBusy !== undefined
                          }
                          onClick={() => onSelectedElementContextAction('ask-ai', selectedElement)}
                        >
                          Ask AI
                        </button>
                        <button
                          type="button"
                          disabled={
                            textEditBusy || layoutBusy !== undefined || resizeBusy !== undefined
                          }
                          onClick={() => onSelectedElementContextAction('inspect', selectedElement)}
                        >
                          Inspect
                        </button>
                        <button
                          type="button"
                          aria-expanded={textEditSession !== undefined}
                          aria-controls="artifact-direct-text-editor"
                          disabled={
                            textEditBusy ||
                            layoutBusy !== undefined ||
                            resizeBusy !== undefined ||
                            moveBusy ||
                            structureBusy
                          }
                          onClick={() => {
                            if (textEditSession) {
                              setTextEditSession(undefined);
                              setResizeStatus(undefined);
                            } else void beginTextEdit();
                          }}
                        >
                          {textEditSession ? 'Close text' : 'Edit text'}
                        </button>
                      </div>
                      {textEditSession ? (
                        <form
                          id="artifact-direct-text-editor"
                          className="artifact-direct-text-editor"
                          aria-label="Edit selected React text"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void commitTextEdit();
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'Escape') return;
                            event.preventDefault();
                            event.stopPropagation();
                            setTextEditSession(undefined);
                            setResizeStatus('Text edit canceled.');
                          }}
                        >
                          <label>
                            <span>React text</span>
                            <textarea
                              rows={2}
                              maxLength={textEditSession.maxLength}
                              value={textEditSession.draft}
                              onChange={(event) =>
                                setTextEditSession((current) =>
                                  current ? { ...current, draft: event.target.value } : current
                                )
                              }
                            />
                          </label>
                          <div>
                            <button
                              type="submit"
                              disabled={
                                textEditBusy ||
                                textEditSession.draft === textEditSession.originalContent
                              }
                            >
                              {textEditBusy ? 'Saving…' : 'Save text'}
                            </button>
                            <button
                              type="button"
                              disabled={textEditBusy}
                              onClick={() => {
                                setTextEditSession(undefined);
                                setResizeStatus('Text edit canceled.');
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : null}
                      {autoLayoutAvailable ? (
                        <div
                          className="artifact-auto-layout-toolbar"
                          role="toolbar"
                          aria-label="Selected container auto layout"
                          aria-busy={layoutBusy !== undefined}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <span className="artifact-auto-layout-toolbar__label">Auto layout</span>
                          <span className="artifact-auto-layout-toolbar__gap">
                            <button
                              type="button"
                              aria-label="Decrease container gap"
                              aria-keyshortcuts="- Shift+-"
                              disabled={
                                layoutBusy !== undefined ||
                                textEditBusy ||
                                textEditSession !== undefined ||
                                selectedGapPixels === undefined
                              }
                              title={
                                selectedGapPixels === undefined
                                  ? 'Direct stepping requires one pixel gap. Use Inspect for tokens or multi-axis values.'
                                  : 'Decrease gap by 1px; hold Shift for 8px'
                              }
                              onClick={(event) => {
                                const next = nextArtifactGap(selectedGap, -1, event.shiftKey);
                                if (next !== undefined) void commitAutoLayout('gap', next);
                              }}
                            >
                              −
                            </button>
                            <output aria-label="Current container gap">
                              {selectedGapPixels === undefined
                                ? 'Gap —'
                                : `Gap ${selectedGapPixels}px`}
                            </output>
                            <button
                              type="button"
                              aria-label="Increase container gap"
                              aria-keyshortcuts="+ Shift++"
                              disabled={
                                layoutBusy !== undefined ||
                                textEditBusy ||
                                textEditSession !== undefined ||
                                selectedGapPixels === undefined
                              }
                              title={
                                selectedGapPixels === undefined
                                  ? 'Direct stepping requires one pixel gap. Use Inspect for tokens or multi-axis values.'
                                  : 'Increase gap by 1px; hold Shift for 8px'
                              }
                              onClick={(event) => {
                                const next = nextArtifactGap(selectedGap, 1, event.shiftKey);
                                if (next !== undefined) void commitAutoLayout('gap', next);
                              }}
                            >
                              +
                            </button>
                          </span>
                          <label>
                            <span>Align</span>
                            <select
                              aria-label="Align container items"
                              value={selectedAlignItems}
                              disabled={
                                layoutBusy !== undefined ||
                                textEditBusy ||
                                textEditSession !== undefined
                              }
                              onChange={(event) => {
                                if (event.currentTarget.value)
                                  void commitAutoLayout('alignItems', event.currentTarget.value);
                              }}
                            >
                              <option value="">Custom</option>
                              {artifactAlignItemsValues.map((value) => (
                                <option value={value} key={value}>
                                  {value}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>Distribute</span>
                            <select
                              aria-label="Distribute container items"
                              value={selectedJustifyContent}
                              disabled={
                                layoutBusy !== undefined ||
                                textEditBusy ||
                                textEditSession !== undefined
                              }
                              onChange={(event) => {
                                if (event.currentTarget.value)
                                  void commitAutoLayout(
                                    'justifyContent',
                                    event.currentTarget.value
                                  );
                              }}
                            >
                              <option value="">Custom</option>
                              {artifactJustifyContentValues.map((value) => (
                                <option value={value} key={value}>
                                  {value}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                      ) : null}
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
                  </div>,
                  directToolbarPortal
                )
              : null}
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
