import type { HTMLAttributes, ReactNode, Ref } from 'react';

import { classNames } from './class-names';
import './foundation.css';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  readonly children: ReactNode;
  readonly as?: 'article' | 'section' | 'div';
  readonly ref?: Ref<HTMLElement>;
}

/** A low-emphasis surface container. It deliberately adds no landmark or heading semantics. */
export function Card({
  as: Component = 'div',
  children,
  className,
  ref,
  ...elementProps
}: CardProps) {
  const classes = classNames('sl-card', className);
  if (Component === 'article') {
    return (
      <article
        {...elementProps}
        className={classes}
        ref={ref as Ref<HTMLElementTagNameMap['article']>}
      >
        {children}
      </article>
    );
  }
  if (Component === 'section') {
    return (
      <section
        {...elementProps}
        className={classes}
        ref={ref as Ref<HTMLElementTagNameMap['section']>}
      >
        {children}
      </section>
    );
  }
  return (
    <div {...elementProps} className={classes} ref={ref as Ref<HTMLDivElement>}>
      {children}
    </div>
  );
}
