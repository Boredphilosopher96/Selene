import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RendererRecoverySurface } from './renderer-recovery';

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
  it('keeps retry and reload behind injected recovery capabilities', () => {
    const onRetry = vi.fn();
    const onReload = vi.fn();
    const fallback = element(RendererRecoverySurface({ onRetry, onReload }));
    const card = element(Children.toArray(fallback.props.children)[0]);
    const actions = element(Children.toArray(card.props.children).at(-1));
    const retry = element(Children.toArray(actions.props.children)[0]);
    const reload = element(Children.toArray(actions.props.children)[1]);

    retry.props.onClick?.();
    reload.props.onClick?.();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onReload).toHaveBeenCalledOnce();
  });
});
