import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { classNames } from './class-names';
import { boundedLabel } from './label-contract';
import './foundation.css';
export interface ListRowProps extends HTMLAttributes<HTMLDivElement> {
  readonly children: ReactNode;
  readonly emphasized?: boolean;
}
export function ListRow({ children, className, emphasized = false, ...props }: ListRowProps) {
  return (
    <div
      {...props}
      className={classNames('sl-list-row', className)}
      data-emphasized={emphasized || undefined}
    >
      {children}
    </div>
  );
}
export interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  readonly label: string;
  readonly max?: number;
  readonly value: number;
}
export const Progress = forwardRef<HTMLDivElement, ProgressProps>(function Progress(
  { className, label, max = 100, value, ...props },
  ref
) {
  const safeLabel = boundedLabel('Progress label', label);
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const safeValue = Number.isFinite(value) ? Math.min(Math.max(value, 0), safeMax) : 0;
  return (
    <div
      {...props}
      aria-label={safeLabel}
      aria-valuemax={safeMax}
      aria-valuemin={0}
      aria-valuenow={safeValue}
      className={classNames('sl-progress', className)}
      ref={ref}
      role="progressbar"
    >
      <span className="sl-progress__bar" style={{ width: `${(safeValue / safeMax) * 100}%` }} />
    </div>
  );
});
export interface ActivityProps extends HTMLAttributes<HTMLDivElement> {
  readonly label: string;
}
export function Activity({ className, label, ...props }: ActivityProps) {
  const safeLabel = boundedLabel('Activity label', label);
  return (
    <div
      {...props}
      aria-label={safeLabel}
      className={classNames('sl-activity', className)}
      role="status"
    >
      <span aria-hidden="true" className="sl-activity__spinner" />
      {safeLabel}
    </div>
  );
}
export interface StatePanelProps extends HTMLAttributes<HTMLElement> {
  readonly children: ReactNode;
  readonly heading: string;
  readonly tone?: 'empty' | 'error' | 'loading';
}
export function StatePanel({
  children,
  className,
  heading,
  tone = 'empty',
  ...props
}: StatePanelProps) {
  const safeHeading = boundedLabel('StatePanel heading', heading);
  return (
    <section
      {...props}
      className={classNames('sl-state-panel sl-state-panel--primitive', className)}
      data-tone={tone}
    >
      <h2>{safeHeading}</h2>
      <div className="sl-state-panel__body">{children}</div>
    </section>
  );
}

export interface InspectorSectionProps extends HTMLAttributes<HTMLElement> {
  readonly children: ReactNode;
  readonly title: string;
}
export function InspectorSection({ children, className, title, ...props }: InspectorSectionProps) {
  const safeTitle = boundedLabel('InspectorSection title', title);
  return (
    <section {...props} className={classNames('sl-inspector-section', className)}>
      <h2>{safeTitle}</h2>
      {children}
    </section>
  );
}
export interface CanvasChromeProps extends HTMLAttributes<HTMLDivElement> {
  readonly children: ReactNode;
  readonly label: string;
}
export const CanvasChrome = forwardRef<HTMLDivElement, CanvasChromeProps>(function CanvasChrome(
  { children, className, label, ...props },
  ref
) {
  const safeLabel = boundedLabel('CanvasChrome label', label);
  return (
    <div
      {...props}
      aria-label={safeLabel}
      className={classNames('sl-canvas-chrome', className)}
      ref={ref}
      role="region"
    >
      {children}
    </div>
  );
});
