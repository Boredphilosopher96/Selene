import { Component, createRef, Fragment, type ReactNode, type RefObject } from 'react';

import './renderer-recovery.css';

interface RendererRecoveryBoundaryProps {
  readonly children: ReactNode;
  /** Host-integrated reload capability; the renderer never reloads the window directly. */
  readonly onReload: () => void;
}

interface RendererRecoveryBoundaryState {
  readonly failed: boolean;
  readonly retryKey: number;
}

interface RendererRecoverySurfaceProps {
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly titleRef?: RefObject<HTMLHeadingElement | null>;
}

/** Deliberately receives actions, never an Error object or other local workspace data. */
export function RendererRecoverySurface({
  onRetry,
  onReload,
  titleRef
}: RendererRecoverySurfaceProps) {
  return (
    <main className="renderer-recovery" aria-labelledby="renderer-recovery-title">
      <section className="renderer-recovery__card" role="alert">
        <span className="renderer-recovery__mark" aria-hidden="true">
          S
        </span>
        <p className="renderer-recovery__eyebrow">Selene desktop designer</p>
        <h1 id="renderer-recovery-title" ref={titleRef} tabIndex={-1}>
          The workspace needs to recover
        </h1>
        <p>
          The designer stopped unexpectedly. Your local project is safe and has not been shared.
        </p>
        <div className="renderer-recovery__actions">
          <button type="button" onClick={onRetry}>
            Retry workspace
          </button>
          <button type="button" className="renderer-recovery__secondary" onClick={onReload}>
            Reload window
          </button>
        </div>
      </section>
    </main>
  );
}

/**
 * Keeps an unexpected renderer exception inside the unprivileged React surface.
 *
 * The fallback deliberately exposes no thrown message or stack: those may contain
 * host paths, generated source, or other local workspace material. Retrying remounts
 * only the renderer tree; a full reload remains an explicit user action.
 */
export class RendererRecoveryBoundary extends Component<
  RendererRecoveryBoundaryProps,
  RendererRecoveryBoundaryState
> {
  public override state: RendererRecoveryBoundaryState = { failed: false, retryKey: 0 };

  private readonly title = createRef<HTMLHeadingElement>();

  public static getDerivedStateFromError(): Pick<RendererRecoveryBoundaryState, 'failed'> {
    return { failed: true };
  }

  public override componentDidCatch(): void {
    queueMicrotask(() => this.title.current?.focus());
  }

  private readonly retry = (): void => {
    this.setState(({ retryKey }) => ({ failed: false, retryKey: retryKey + 1 }));
  };

  public override render(): ReactNode {
    if (this.state.failed)
      return (
        <RendererRecoverySurface
          onRetry={this.retry}
          onReload={this.props.onReload}
          titleRef={this.title}
        />
      );
    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }
}
