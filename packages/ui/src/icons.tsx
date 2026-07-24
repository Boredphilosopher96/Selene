import type { ComponentPropsWithRef, ReactNode } from 'react';

import { classNames } from './class-names';
import './foundation.css';

export interface IconProps extends Omit<ComponentPropsWithRef<'svg'>, 'children'> {
  readonly title?: string;
}

function IconSvg({
  children,
  className,
  title,
  ...svgProps
}: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      {...svgProps}
      aria-hidden={title === undefined ? true : undefined}
      className={classNames('sl-icon', className)}
      fill="none"
      role={title === undefined ? undefined : 'img'}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      {title === undefined ? null : <title>{title}</title>}
      {children}
    </svg>
  );
}

/** Code-native addition icon; no icon package is included in the product bundle. */
export function AddIcon(props: IconProps) {
  return (
    <IconSvg {...props}>
      <path d="M12 5v14M5 12h14" />
    </IconSvg>
  );
}

/** Code-native close icon; no icon package is included in the product bundle. */
export function CloseIcon(props: IconProps) {
  return (
    <IconSvg {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </IconSvg>
  );
}
