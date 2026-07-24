import type { ReactNode } from 'react';

import { boundedLabel } from './label-contract';

export interface PlaceholderPanelProps {
  readonly title: string;
  readonly children?: ReactNode;
}

/** A deliberately neutral shell for the shared component system. */
export function PlaceholderPanel({ title, children }: PlaceholderPanelProps) {
  const safeTitle = boundedLabel('PlaceholderPanel title', title);
  return (
    <section aria-label={safeTitle} style={{ border: '1px solid currentColor', padding: '1rem' }}>
      <h2>{safeTitle}</h2>
      {children}
    </section>
  );
}
