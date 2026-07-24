import type { ComponentPropsWithRef, ReactNode } from 'react';

import { classNames } from './class-names';
import './foundation.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly loading?: boolean;
}

/** A native button with semantic variants and an explicit loading state. */
export function Button({
  children,
  className,
  disabled,
  loading = false,
  ref,
  type = 'button',
  variant = 'primary',
  ...buttonProps
}: ButtonProps) {
  return (
    <button
      {...buttonProps}
      aria-busy={loading || undefined}
      className={classNames('sl-button', `sl-button--${variant}`, className)}
      disabled={disabled || loading}
      ref={ref}
      type={type}
    >
      {children}
    </button>
  );
}
