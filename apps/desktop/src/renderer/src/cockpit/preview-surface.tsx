import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject
} from 'react';

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

type CanvasTargetTool = 'ai' | 'review';

interface PreviewSurfaceProps {
  readonly build?: PreviewBuild;
  readonly revisionId: string;
  readonly readiness: string;
  readonly frame: RefObject<HTMLIFrameElement | null>;
  readonly onFrameLoad: (frame: HTMLIFrameElement) => void;
  readonly onFrameError: (frame: HTMLIFrameElement) => void;
  readonly targeting: boolean;
  readonly targetMode: 'idle' | 'ai' | 'review';
  readonly canTargetAi: boolean;
  readonly canTargetReview: boolean;
  readonly onSelectTargetTool: (tool: CanvasTargetTool, invoking: HTMLButtonElement) => void;
  readonly onCancelTargeting: (invoking: HTMLButtonElement) => void;
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
  desktop: { label: 'Desktop', width: 1440, height: 900 },
  tablet: { label: 'Tablet', width: 834, height: 1112 },
  phone: { label: 'Phone', width: 390, height: 844 }
};
type PreviewDevice = keyof typeof previewDeviceById;
const previewDevices: readonly PreviewDevice[] = ['desktop', 'tablet', 'phone'];
const minimumPreviewZoom = 0.2;
const maximumPreviewZoom = 1.5;
const maximumPreviewPan = 180;
const previewPanStep = 48;

function clampPreviewZoom(value: number): number {
  return Math.min(maximumPreviewZoom, Math.max(minimumPreviewZoom, Math.round(value * 100) / 100));
}

function clampPreviewPan(value: number): number {
  return Math.min(maximumPreviewPan, Math.max(-maximumPreviewPan, Math.round(value)));
}

function nonnegativeCssPixels(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function previewContentSize(viewport: HTMLDivElement): {
  readonly width: number;
  readonly height: number;
} {
  const bounds = viewport.getBoundingClientRect();
  if (
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  )
    return { width: 0, height: 0 };
  try {
    const style = getComputedStyle(viewport);
    const left = nonnegativeCssPixels(style.paddingLeft);
    const right = nonnegativeCssPixels(style.paddingRight);
    const top = nonnegativeCssPixels(style.paddingTop);
    const bottom = nonnegativeCssPixels(style.paddingBottom);
    const borderLeft = nonnegativeCssPixels(style.borderLeftWidth);
    const borderRight = nonnegativeCssPixels(style.borderRightWidth);
    const borderTop = nonnegativeCssPixels(style.borderTopWidth);
    const borderBottom = nonnegativeCssPixels(style.borderBottomWidth);
    if (
      left === undefined ||
      right === undefined ||
      top === undefined ||
      bottom === undefined ||
      borderLeft === undefined ||
      borderRight === undefined ||
      borderTop === undefined ||
      borderBottom === undefined
    )
      return { width: 0, height: 0 };

    // Floor a live content-box measurement: Fit must never round an authored artifact
    // beyond the viewport that the transformed stage is actually painted into.
    return {
      width: Math.max(
        0,
        Math.floor(
          (Math.min(viewport.clientWidth, bounds.width - borderLeft - borderRight) - left - right) *
            1000
        ) / 1000
      ),
      height: Math.max(
        0,
        Math.floor(
          (Math.min(viewport.clientHeight, bounds.height - borderTop - borderBottom) -
            top -
            bottom) *
            1000
        ) / 1000
      )
    };
  } catch {
    return { width: 0, height: 0 };
  }
}

function nextPreviewDevice(current: PreviewDevice, key: string): PreviewDevice | undefined {
  if (key === 'Home') return 'desktop';
  if (key === 'End') return 'phone';
  if (key === 'ArrowLeft' || key === 'ArrowUp')
    return current === 'desktop' ? 'phone' : current === 'tablet' ? 'desktop' : 'tablet';
  if (key === 'ArrowRight' || key === 'ArrowDown')
    return current === 'desktop' ? 'tablet' : current === 'tablet' ? 'phone' : 'desktop';
  return undefined;
}

/** Sandboxed compiled preview plus trusted-host spatial targeting and pin affordances. */
export function PreviewSurface({
  build,
  revisionId,
  readiness,
  frame,
  onFrameLoad,
  onFrameError,
  targeting,
  targetMode,
  canTargetAi,
  canTargetReview,
  onSelectTargetTool,
  onCancelTargeting,
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
}: PreviewSurfaceProps) {
  const card = useRef<HTMLElement | null>(null);
  const deviceControls = useRef(new Map<PreviewDevice, HTMLButtonElement>());
  const previewViewport = useRef<HTMLDivElement | null>(null);
  const panPointer = useRef<
    | {
        readonly id: number;
        readonly x: number;
        readonly y: number;
        readonly control: HTMLDivElement;
      }
    | undefined
  >(undefined);
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>('desktop');
  const [manualZoom, setManualZoom] = useState(1);
  const [zoomMode, setZoomMode] = useState<'fit' | 'manual'>('fit');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panMode, setPanMode] = useState(false);
  const [activatePanWhenIdle, setActivatePanWhenIdle] = useState(false);
  const [panning, setPanning] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const selectedPreviewDevice = previewDeviceById[previewDevice];
  const { width: artifactWidth, height: artifactHeight } = selectedPreviewDevice;
  const fitZoom =
    viewportSize.width > 0 && viewportSize.height > 0
      ? Math.min(
          maximumPreviewZoom,
          viewportSize.width / artifactWidth,
          viewportSize.height / artifactHeight,
          1
        )
      : minimumPreviewZoom;
  const zoom = zoomMode === 'fit' ? fitZoom : manualZoom;
  const renderedWidth = artifactWidth * zoom;
  const renderedHeight = artifactHeight * zoom;
  const panPadding = zoomMode === 'fit' ? 0 : maximumPreviewPan;
  const canvasWidth = Math.ceil(Math.max(viewportSize.width, renderedWidth + panPadding * 2));
  const canvasHeight = Math.ceil(Math.max(viewportSize.height, renderedHeight + panPadding * 2));
  const stageLeft = Math.floor((canvasWidth - renderedWidth) / 2);
  const stageTop = Math.floor((canvasHeight - renderedHeight) / 2);
  useEffect(() => {
    if (selectedThread)
      requestAnimationFrame(() =>
        card.current?.querySelector<HTMLButtonElement>('button')?.focus()
      );
  }, [selectedThread?.id]);
  useLayoutEffect(() => {
    const viewport = previewViewport.current;
    if (!viewport) return;
    const measureViewport = () => {
      const { width: availableWidth, height: availableHeight } = previewContentSize(viewport);
      setViewportSize((current) =>
        current.width === availableWidth && current.height === availableHeight
          ? current
          : { width: availableWidth, height: availableHeight }
      );
    };
    measureViewport();
    let settleFrame: number | undefined;
    const scheduleMeasure = () => {
      if (settleFrame !== undefined) cancelAnimationFrame(settleFrame);
      settleFrame = requestAnimationFrame(() => {
        measureViewport();
        settleFrame = requestAnimationFrame(measureViewport);
      });
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      if (settleFrame !== undefined) cancelAnimationFrame(settleFrame);
    };
  }, []);
  useEffect(() => {
    if (zoomMode !== 'fit') return;
    const frameId = requestAnimationFrame(() => {
      const viewport = previewViewport.current;
      if (!viewport) return;
      viewport.scrollLeft = Math.max(0, (canvasWidth - viewport.clientWidth) / 2);
      viewport.scrollTop = Math.max(0, (canvasHeight - viewport.clientHeight) / 2);
    });
    return () => cancelAnimationFrame(frameId);
  }, [canvasHeight, canvasWidth, zoomMode]);
  useEffect(() => {
    if (!targeting) return;
    const active = panPointer.current;
    if (active?.control.hasPointerCapture(active.id))
      active.control.releasePointerCapture(active.id);
    panPointer.current = undefined;
    setPanning(false);
    setPanMode(false);
    setActivatePanWhenIdle(false);
  }, [targeting]);
  useEffect(() => {
    if (targeting || !activatePanWhenIdle) return;
    setPanMode(true);
    setActivatePanWhenIdle(false);
  }, [activatePanWhenIdle, targeting]);
  useEffect(
    () => () => {
      const active = panPointer.current;
      if (active?.control.hasPointerCapture(active.id))
        active.control.releasePointerCapture(active.id);
      panPointer.current = undefined;
    },
    []
  );
  const useManualZoom = (next: number) => {
    setManualZoom(clampPreviewZoom(next));
    setZoomMode('manual');
  };
  const movePan = (x: number, y: number) => {
    if (zoomMode === 'fit') {
      setManualZoom(fitZoom);
      setZoomMode('manual');
    }
    setPan((current) => ({
      x: clampPreviewPan(current.x + x),
      y: clampPreviewPan(current.y + y)
    }));
  };
  const resetCanvasPosition = () => {
    setPan({ x: 0, y: 0 });
    requestAnimationFrame(() => {
      const viewport = previewViewport.current;
      if (!viewport) return;
      viewport.scrollLeft = Math.max(0, (canvasWidth - viewport.clientWidth) / 2);
      viewport.scrollTop = Math.max(0, (canvasHeight - viewport.clientHeight) / 2);
    });
  };
  const activateFit = () => {
    setZoomMode('fit');
    resetCanvasPosition();
  };
  const finishCanvasPan = (event?: PointerEvent<HTMLDivElement>) => {
    if (
      event &&
      panPointer.current?.id === event.pointerId &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    )
      event.currentTarget.releasePointerCapture(event.pointerId);
    panPointer.current = undefined;
    setPanning(false);
  };
  const beginCanvasPan = (event: PointerEvent<HTMLDivElement>) => {
    if (targeting || !panMode) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panPointer.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      control: event.currentTarget
    };
    setPanning(true);
  };
  const updateCanvasPan = (event: PointerEvent<HTMLDivElement>) => {
    const previous = panPointer.current;
    if (!previous || previous.id !== event.pointerId) return;
    const x = event.clientX;
    const y = event.clientY;
    panPointer.current = { ...previous, x, y };
    movePan(x - previous.x, y - previous.y);
  };
  const selectPanTool = (invoking: HTMLButtonElement) => {
    if (!targeting) {
      setPanMode(true);
      return;
    }
    setActivatePanWhenIdle(true);
    onCancelTargeting(invoking);
  };
  const canvasToolGuidance =
    targetMode === 'ai'
      ? 'AI edit target active. Choose a point or drag a region for the selected agent.'
      : targetMode === 'review'
        ? 'Review comment active. Choose a point or drag a region for a stakeholder thread.'
        : panMode
          ? panning
            ? 'Hand tool active. Moving the artifact canvas.'
            : 'Hand tool active. Drag the artifact canvas to pan.'
          : 'Interact active. Use the compiled preview directly; scroll moves the canvas.';
  const targetFeedback =
    targetMode === 'ai'
      ? 'AI target: click a point or drag a bounded region.'
      : targetMode === 'review'
        ? 'Review target: click a point or drag a bounded region.'
        : panMode
          ? 'Pan enabled: drag the canvas or use the position controls.'
          : 'Interact mode: the sandboxed Orders artifact receives input.';
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
    <section className="preview-pane">
      <div className="preview-toolbar" aria-label="Preview status">
        <span className="preview-toolbar__identity">
          <strong>Compiled preview</strong>
          <code>{revisionId}</code>
        </span>
        <span className="preview-toolbar__badges">
          <span className="preview-toolbar__badge">{readiness}</span>
          <span className="preview-toolbar__badge is-secure">Sandboxed</span>
        </span>
        <span className="preview-display-controls">
          <span
            className="preview-device-controls"
            role="radiogroup"
            aria-label="Rendered artifact width"
          >
            {previewDevices.map((device) => (
              <button
                key={device}
                type="button"
                role="radio"
                aria-checked={previewDevice === device}
                tabIndex={previewDevice === device ? 0 : -1}
                ref={(element) => {
                  if (element) deviceControls.current.set(device, element);
                  else deviceControls.current.delete(device);
                }}
                onClick={() => {
                  setPreviewDevice(device);
                  resetCanvasPosition();
                }}
                onKeyDown={(event) => {
                  const next = nextPreviewDevice(previewDevice, event.key);
                  if (next === undefined) return;
                  event.preventDefault();
                  setPreviewDevice(next);
                  resetCanvasPosition();
                  requestAnimationFrame(() => deviceControls.current.get(next)?.focus());
                }}
              >
                {previewDeviceById[device].label}
              </button>
            ))}
          </span>
          <span className="preview-zoom-controls" role="group" aria-label="Artifact zoom">
            <button
              type="button"
              aria-label="Zoom out generated artifact"
              disabled={zoom <= minimumPreviewZoom}
              onClick={() => useManualZoom(zoom - 0.1)}
            >
              −
            </button>
            <button
              type="button"
              className="preview-zoom-controls__fit"
              aria-pressed={zoomMode === 'fit'}
              onClick={activateFit}
            >
              Fit
            </button>
            <button
              type="button"
              aria-label="Zoom in generated artifact"
              disabled={zoom >= maximumPreviewZoom}
              onClick={() => useManualZoom(zoom + 0.1)}
            >
              +
            </button>
            <label>
              <span className="sr-only">Artifact zoom percentage</span>
              <input
                aria-label="Artifact zoom percentage"
                type="range"
                min={minimumPreviewZoom}
                max={maximumPreviewZoom}
                step=".1"
                value={zoom}
                onChange={(event) => useManualZoom(Number(event.currentTarget.value))}
              />
            </label>
            <output id="preview-artifact-fit-status" aria-live="polite">
              {zoomMode === 'fit' ? 'Fit ' : 'Zoom '}
              {Math.round(zoom * 100)}%
            </output>
          </span>
          <span className="preview-pan-controls" role="group" aria-label="Artifact position">
            <button
              type="button"
              aria-label="Pan artifact left"
              disabled={pan.x <= -maximumPreviewPan}
              onClick={() => movePan(-previewPanStep, 0)}
            >
              ←
            </button>
            <button
              type="button"
              aria-label="Pan artifact up"
              disabled={pan.y <= -maximumPreviewPan}
              onClick={() => movePan(0, -previewPanStep)}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Reset artifact position"
              onClick={resetCanvasPosition}
            >
              Center
            </button>
            <button
              type="button"
              aria-pressed={panMode}
              aria-label="Enable direct canvas pan"
              disabled={targeting}
              onClick={() => setPanMode((current) => !current)}
            >
              Pan
            </button>
            <button
              type="button"
              aria-label="Pan artifact down"
              disabled={pan.y >= maximumPreviewPan}
              onClick={() => movePan(0, previewPanStep)}
            >
              ↓
            </button>
            <button
              type="button"
              aria-label="Pan artifact right"
              disabled={pan.x >= maximumPreviewPan}
              onClick={() => movePan(previewPanStep, 0)}
            >
              →
            </button>
          </span>
        </span>
        <span className="preview-toolbar__selection" aria-live="polite">
          {targetMode === 'ai'
            ? 'Picking AI target'
            : targetMode === 'review'
              ? 'Picking review location'
              : aiTarget && reviewTarget
                ? 'AI and review targets saved'
                : aiTarget
                  ? 'AI target saved'
                  : reviewTarget
                    ? 'Review target saved'
                    : 'Ready for selection'}
        </span>
      </div>
      <div
        className="preview-device"
        data-targeting={targeting || undefined}
        data-target-mode={targetMode}
        data-preview-state={build ? 'ready' : 'loading'}
      >
        <div className="preview-device__chrome" aria-hidden="true">
          <span className="preview-device__camera" />
          <span>{selectedPreviewDevice.label} artifact</span>
          <span className="preview-device__telemetry">
            {artifactWidth} × {artifactHeight} · {Math.round(zoom * 100)}%
          </span>
          <span className="preview-device__mode" data-target-mode={targetMode}>
            {targetFeedback}
          </span>
        </div>
        <div className="canvas-tool-palette" role="toolbar" aria-label="Canvas tools">
          <span className="canvas-tool-palette__label">Canvas</span>
          <div className="canvas-tool-palette__tools">
            <button
              type="button"
              className="canvas-tool-palette__tool is-interact"
              aria-pressed={targetMode === 'idle' && !panMode}
              title="Interact with the compiled preview"
              onClick={(event) => {
                setActivatePanWhenIdle(false);
                setPanMode(false);
                onCancelTargeting(event.currentTarget);
              }}
            >
              <span>Interact</span>
              <small>preview</small>
            </button>
            <button
              type="button"
              className="canvas-tool-palette__tool is-pan"
              aria-pressed={panMode}
              title="Hand tool: drag the artifact canvas"
              onClick={(event) => selectPanTool(event.currentTarget)}
            >
              <span>Pan</span>
              <small>hand</small>
            </button>
            <button
              type="button"
              className="canvas-tool-palette__tool is-ai"
              aria-pressed={targetMode === 'ai'}
              disabled={!canTargetAi}
              title="AI edit target: send a spatial instruction to the selected agent"
              onClick={(event) => {
                setActivatePanWhenIdle(false);
                setPanMode(false);
                onSelectTargetTool('ai', event.currentTarget);
              }}
            >
              <span>AI edit</span>
              <small>agent target</small>
            </button>
            <button
              type="button"
              className="canvas-tool-palette__tool is-review"
              aria-pressed={targetMode === 'review'}
              disabled={!canTargetReview}
              title="Review comment: place a stakeholder discussion on the artifact"
              onClick={(event) => {
                setActivatePanWhenIdle(false);
                setPanMode(false);
                onSelectTargetTool('review', event.currentTarget);
              }}
            >
              <span>Review</span>
              <small>comment</small>
            </button>
          </div>
          <p className="canvas-tool-palette__guidance" role="status" aria-live="polite">
            {canvasToolGuidance}
          </p>
        </div>
        <div
          className="preview-device__viewport"
          ref={previewViewport}
          role="region"
          aria-label="Generated artifact canvas viewport"
          aria-describedby="preview-artifact-fit-status"
          tabIndex={0}
        >
          <div
            className="preview-artifact-canvas"
            style={
              {
                '--preview-canvas-width': `${canvasWidth}px`,
                '--preview-canvas-height': `${canvasHeight}px`
              } as CSSProperties
            }
          >
            <div
              className="preview-artifact-stage"
              data-preview-device={previewDevice}
              style={
                {
                  '--preview-artifact-width': `${artifactWidth}px`,
                  '--preview-artifact-height': `${artifactHeight}px`,
                  '--preview-stage-left': `${stageLeft}px`,
                  '--preview-stage-top': `${stageTop}px`,
                  '--preview-zoom': zoom,
                  '--preview-pan-x': `${pan.x}px`,
                  '--preview-pan-y': `${pan.y}px`,
                  // These are the measured Fit coordinates. Keep the actual box
                  // inline-authoritative so shared workspace CSS cannot hide the
                  // compiled iframe behind a stale stage offset.
                  top: `${stageTop}px`,
                  left: `${stageLeft}px`,
                  width: `${artifactWidth}px`,
                  height: `${artifactHeight}px`
                } as CSSProperties
              }
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
              {panMode && !targeting ? (
                <div
                  className="preview-pan-layer"
                  aria-hidden="true"
                  data-panning={panning || undefined}
                  onPointerDown={beginCanvasPan}
                  onPointerMove={updateCanvasPan}
                  onPointerUp={finishCanvasPan}
                  onPointerCancel={finishCanvasPan}
                  onLostPointerCapture={() => finishCanvasPan()}
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
                  aria-pressed={selectedPinId === pin.id}
                  aria-label={`Select artifact pin ${pin.label}`}
                  onClick={(event) => onSelectPin(pin.id, event.currentTarget)}
                  style={{ left: `${pin.anchor.x * 100}%`, top: `${pin.anchor.y * 100}%` }}
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
                  style={{
                    left: `${Math.min(72, Math.max(4, selectedThread.anchor.x * 100 + 2))}%`,
                    top: `${Math.min(72, Math.max(4, selectedThread.anchor.y * 100 + 2))}%`
                  }}
                >
                  <header>
                    <span>
                      <strong>
                        {selectedThread.status === 'resolved'
                          ? 'Resolved review'
                          : 'Stakeholder review'}
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
                  <p className="shortcut-hint">
                    ⌘/Ctrl + Enter replies · Escape closes this thread.
                  </p>
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
                        void onResolveThread(
                          selectedThread.id,
                          selectedThread.status !== 'resolved'
                        )
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
          </div>
        </div>
      </div>
    </section>
  );
}
