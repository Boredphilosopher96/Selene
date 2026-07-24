import type { ComponentPropsWithRef, ReactNode } from 'react';

import { classNames } from './class-names';
import './foundation.css';

export interface IconButtonProps extends Omit<
  ComponentPropsWithRef<'button'>,
  'aria-label' | 'children'
> {
  /** Accessible name announced by assistive technology. */
  readonly label: string;
  /** A decorative code-native icon. The button supplies the accessible name. */
  readonly icon: ReactNode;
}

/** A compact native button for an icon-only action. */
export function IconButton({
  className,
  icon,
  label,
  ref,
  type = 'button',
  ...buttonProps
}: IconButtonProps) {
  return (
    <button
      {...buttonProps}
      aria-label={label}
      className={classNames('sl-icon-button', className)}
      ref={ref}
      type={type}
    >
      {icon}
    </button>
  );
}
