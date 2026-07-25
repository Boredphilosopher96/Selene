import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RendererRecoveryBoundary } from './renderer-recovery';

interface RecoveryElementProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
}

function element(value: ReactNode): ReactElement<RecoveryElementProps> {
  if (!isValidElement<RecoveryElementProps>(value))
    throw new Error('Renderer recovery fallback did not produce an element.');
  return value;
}

describe('RendererRecoveryBoundary', () => {
  it('uses the injected reload capability for the recovery action', () => {
    const onReload = vi.fn();
    const boundary = new RendererRecoveryBoundary({ children: null, onReload });
    boundary.state = { failed: true, retryKey: 0 };

    const fallback = element(boundary.render());
    const card = element(Children.toArray(fallback.props.children)[0]);
    const actions = element(Children.toArray(card.props.children).at(-1));
    const reload = element(Children.toArray(actions.props.children)[1]);

    reload.props.onClick?.();
    expect(onReload).toHaveBeenCalledOnce();
  });
});
