import type { ReactNode } from 'react';

export interface PlaceholderPanelProps {
  readonly title: string;
  readonly children?: ReactNode;
}

/** A deliberately neutral shell for the shared component system. */
export function PlaceholderPanel({ title, children }: PlaceholderPanelProps) {
  return (
    <section aria-label={title} style={{ border: '1px solid currentColor', padding: '1rem' }}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
