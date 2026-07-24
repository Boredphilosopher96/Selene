import {
  forwardRef,
  useId,
  useMemo,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode
} from 'react';
import { classNames } from './class-names';
import { boundedLabel } from './label-contract';
import {
  issueCollectionContractError,
  ownDataValue,
  snapshotCollection,
  useAcknowledgedSelectionFocus,
  useControllableValue
} from './workspace-collection-contracts';
import './foundation.css';
export interface TabItem {
  readonly disabled?: boolean;
  readonly id: string;
  readonly label: string;
  readonly panel: ReactNode;
}
type ControllableString =
  | {
      readonly defaultValue?: string;
      readonly onValueChange?: (value: string) => void;
      readonly value?: undefined;
    }
  | {
      readonly defaultValue?: never;
      readonly onValueChange: (value: string) => void;
      readonly value: string;
    };
export type TabsProps = Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> &
  ControllableString & {
    readonly label: string;
    readonly orientation?: 'horizontal' | 'vertical';
    readonly tabs: readonly TabItem[];
  };
export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  {
    className,
    defaultValue,
    label,
    onValueChange,
    orientation = 'horizontal',
    tabs,
    value,
    ...props
  },
  ref
) {
  if (value !== undefined && typeof onValueChange !== 'function')
    throw issueCollectionContractError('Tabs controlled value requires onValueChange.');
  const items = useMemo(
    () =>
      snapshotCollection<TabItem>('Tabs', tabs, (entry) => ({
        panel: ownDataValue(entry, 'panel') as ReactNode
      })),
    [tabs]
  );
  const safeLabel = boundedLabel('Tabs label', label);
  const enabled = items.filter((item) => !item.disabled);
  const fallback = enabled[0]?.id ?? '';
  const [requested, setRequested] = useControllableValue(
    value,
    defaultValue ?? fallback,
    onValueChange
  );
  const selected = enabled.some((item) => item.id === requested) ? requested : fallback;
  const baseId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const acknowledgeFocus = useAcknowledgedSelectionFocus(
    items,
    selected,
    value !== undefined,
    refs
  );
  const select = (index: number, requestFocus = false) => {
    const item = items[index];
    if (item === undefined || item.disabled) return;
    if (requestFocus) acknowledgeFocus(index);
    setRequested(item.id);
  };
  const move = (index: number, direction: -1 | 1) => {
    const indexes = items.flatMap((item, itemIndex) => (item.disabled ? [] : [itemIndex]));
    const current = indexes.indexOf(index);
    if (current < 0) return;
    select(indexes[(current + direction + indexes.length) % indexes.length] ?? index, true);
  };
  const keys = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    const previous = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    if (event.key === next) {
      event.preventDefault();
      move(index, 1);
    } else if (event.key === previous) {
      event.preventDefault();
      move(index, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      select(
        items.findIndex((item) => !item.disabled),
        true
      );
    } else if (event.key === 'End') {
      event.preventDefault();
      select(items.length - 1 - [...items].reverse().findIndex((item) => !item.disabled), true);
    }
  };
  return (
    <div {...props} className={classNames('sl-tabs', className)} ref={ref}>
      <div
        aria-label={safeLabel}
        aria-orientation={orientation}
        className="sl-tabs__list"
        role="tablist"
      >
        {items.map((item, index) => (
          <button
            aria-controls={`${baseId}-${item.id}-panel`}
            aria-selected={item.id === selected}
            className="sl-tabs__tab"
            disabled={item.disabled}
            id={`${baseId}-${item.id}-tab`}
            key={item.id}
            onClick={() => select(index)}
            onKeyDown={(event) => keys(event, index)}
            ref={(element) => {
              refs.current[index] = element;
            }}
            role="tab"
            tabIndex={item.id === selected ? 0 : -1}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map((item) => (
        <div
          aria-labelledby={`${baseId}-${item.id}-tab`}
          className="sl-tabs__panel"
          hidden={item.id !== selected}
          id={`${baseId}-${item.id}-panel`}
          key={item.id}
          role="tabpanel"
          tabIndex={0}
        >
          {item.panel}
        </div>
      ))}
    </div>
  );
});

export interface SegmentedControlItem {
  readonly disabled?: boolean;
  readonly id: string;
  readonly label: string;
}
export type SegmentedControlProps = Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> &
  ControllableString & {
    readonly label: string;
    readonly options: readonly SegmentedControlItem[];
  };
export const SegmentedControl = forwardRef<HTMLDivElement, SegmentedControlProps>(
  function SegmentedControl(
    { className, defaultValue, label, onValueChange, options, value, ...props },
    ref
  ) {
    if (value !== undefined && typeof onValueChange !== 'function')
      throw issueCollectionContractError(
        'SegmentedControl controlled value requires onValueChange.'
      );
    const items = useMemo(
      () => snapshotCollection<SegmentedControlItem>('SegmentedControl', options),
      [options]
    );
    const safeLabel = boundedLabel('SegmentedControl label', label);
    const enabled = items.filter((item) => !item.disabled);
    const fallback = enabled[0]?.id ?? '';
    const [requested, setRequested] = useControllableValue(
      value,
      defaultValue ?? fallback,
      onValueChange
    );
    const selected = enabled.some((item) => item.id === requested) ? requested : fallback;
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    const acknowledgeFocus = useAcknowledgedSelectionFocus(
      items,
      selected,
      value !== undefined,
      refs
    );
    const select = (index: number, requestFocus = false) => {
      const item = items[index];
      if (item === undefined || item.disabled) return;
      if (requestFocus) acknowledgeFocus(index);
      setRequested(item.id);
    };
    const move = (index: number, direction: -1 | 1) => {
      const indexes = items.flatMap((item, itemIndex) => (item.disabled ? [] : [itemIndex]));
      const current = indexes.indexOf(index);
      if (current < 0) return;
      const next = indexes[(current + direction + indexes.length) % indexes.length];
      if (next !== undefined) select(next, true);
    };
    return (
      <div
        {...props}
        aria-label={safeLabel}
        className={classNames('sl-segmented-control', className)}
        ref={ref}
        role="group"
      >
        {items.map((item, index) => (
          <button
            aria-pressed={item.id === selected}
            disabled={item.disabled}
            key={item.id}
            onClick={() => select(index)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                move(index, -1);
              }
            }}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
    );
  }
);
