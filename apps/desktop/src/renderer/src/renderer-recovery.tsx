import { Component, createRef, Fragment, type ReactNode } from 'react';

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
  public state: RendererRecoveryBoundaryState = { failed: false, retryKey: 0 };

  private readonly title = createRef<HTMLHeadingElement>();

  public static getDerivedStateFromError(): Pick<RendererRecoveryBoundaryState, 'failed'> {
    return { failed: true };
  }

  public componentDidCatch(): void {
    queueMicrotask(() => this.title.current?.focus());
  }

  private readonly retry = (): void => {
    this.setState(({ retryKey }) => ({ failed: false, retryKey: retryKey + 1 }));
  };

  public render(): ReactNode {
    if (this.state.failed)
      return (
        <main className="renderer-recovery" aria-labelledby="renderer-recovery-title">
          <section className="renderer-recovery__card" role="alert">
            <p className="renderer-recovery__eyebrow">Selene desktop designer</p>
            <h1 id="renderer-recovery-title" ref={this.title} tabIndex={-1}>
              The workspace needs to recover
            </h1>
            <p>
              The desktop workspace stopped unexpectedly. Your local project remains on this device.
            </p>
            <div className="renderer-recovery__actions">
              <button type="button" onClick={this.retry}>
                Retry workspace
              </button>
              <button
                type="button"
                className="renderer-recovery__secondary"
                onClick={this.props.onReload}
              >
                Reload window
              </button>
            </div>
          </section>
        </main>
      );
    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }
}
