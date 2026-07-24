import type { ComponentPropsWithRef, ReactNode } from 'react';

import { classNames } from './class-names';
import './foundation.css';

export type StatusBadgeTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface StatusBadgeProps extends Omit<ComponentPropsWithRef<'span'>, 'children'> {
  readonly children: ReactNode;
  readonly tone?: StatusBadgeTone;
}

/** A non-interactive textual status indicator. */
export function StatusBadge({
  children,
  className,
  ref,
  tone = 'neutral',
  ...spanProps
}: StatusBadgeProps) {
  return (
    <span
      {...spanProps}
      className={classNames('sl-status-badge', `sl-status-badge--${tone}`, className)}
      ref={ref}
    >
      {children}
    </span>
  );
}
