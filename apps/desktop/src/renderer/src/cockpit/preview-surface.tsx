import type { PointerEvent, RefObject } from 'react';

import type { SpatialTargetInput } from '../../../shared/designer-api';

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
  readonly onSelectPin: (id: string) => void;
}

/** Sandboxed compiled preview plus trusted-host spatial targeting and pin affordances. */
export function PreviewSurface({
  build, revisionId, readiness, frame, onFrameLoad, targeting, target, onTargetPointerDown,
  onTargetPointerUp, onTargetPointerCancel, onTargetClick, pins, selectedPinId, onSelectPin
}: PreviewSurfaceProps) {
  return (
    <section className="preview-pane">
      <div className="preview-toolbar">
        <span>Compiled React artifact</span>
        <code>{revisionId}</code>
        <span>{readiness}</span>
      </div>
      <div style={{ position: 'relative' }}>
        {build ? <iframe ref={frame} title="Generated React preview frame" src={build.url} onLoad={onFrameLoad} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" style={{ border: '1px solid #ccd', height: 360, width: '100%' }} /> : null}
        {targeting ? (
          <button aria-label="Select a spatial change target in the preview" type="button" onPointerDown={onTargetPointerDown} onPointerUp={onTargetPointerUp} onPointerCancel={onTargetPointerCancel} onClick={onTargetClick} style={{ position: 'absolute', inset: 0, cursor: 'crosshair', border: 0, background: 'transparent', padding: 0 }} />
        ) : null}
        {target ? <span aria-hidden="true" style={{ position: 'absolute', left: `${target.x * 100}%`, top: `${target.y * 100}%`, width: `${(target.width ?? 0.02) * 100}%`, height: `${(target.height ?? 0.02) * 100}%`, border: '2px solid #7c3aed', pointerEvents: 'none' }} /> : null}
        {pins.map((pin) => <button key={pin.id} type="button" aria-pressed={selectedPinId === pin.id} aria-label={`Select artifact pin ${pin.label}`} onClick={() => onSelectPin(pin.id)} style={{ position: 'absolute', left: `${pin.anchor.x * 100}%`, top: `${pin.anchor.y * 100}%`, minWidth: 18, minHeight: 18, borderRadius: '50%', border: selectedPinId === pin.id ? '3px solid #4c1d95' : '2px solid #7c3aed', background: '#f5f3ff', color: '#4c1d95', zIndex: 3 }}>•</button>)}
      </div>
    </section>
  );
}
