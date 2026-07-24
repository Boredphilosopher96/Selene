import {
  forwardRef,
  useId,
  useMemo,
  type ComponentPropsWithRef,
  type HTMLAttributes,
  type ReactNode
} from 'react';
import { classNames } from './class-names';
import { boundedLabel, optionalBoundedLabel } from './label-contract';
import {
  issueCollectionContractError,
  assertExactDataRecord,
  assertExactDenseArray,
  boundedIdentifier,
  collectionLength,
  isIssuedCollectionContractError,
  maximumCollectionItems,
  ownDataValue,
  ownDataValueOrUndefined,
  snapshotCollection
} from './workspace-collection-contracts';
import './foundation.css';
type AppShellBase = Omit<HTMLAttributes<HTMLElement>, 'aria-label'> & {
  readonly children: ReactNode;
};
export type AppShellProps =
  | (AppShellBase & { readonly landmark?: undefined; readonly landmarkLabel?: never })
  | (AppShellBase & { readonly landmark: 'main' | 'section'; readonly landmarkLabel: string });

/** A host-owned wrapper: only named landmarks receive an accessible name. */
export const AppShell = forwardRef<HTMLElement, AppShellProps>(function AppShell(props, ref) {
  const { children, className, ...rest } = props;
  if (props.landmark === 'main') {
    const {
      landmark: _landmark,
      landmarkLabel,
      ...native
    } = rest as AppShellProps & { landmarkLabel: string };
    const safeLandmarkLabel = boundedLabel('AppShell landmarkLabel', landmarkLabel);
    return (
      <main
        {...native}
        aria-label={safeLandmarkLabel}
        className={classNames('sl-app-shell', className)}
        ref={ref}
      >
        {children}
      </main>
    );
  }
  if (props.landmark === 'section') {
    const {
      landmark: _landmark,
      landmarkLabel,
      ...native
    } = rest as AppShellProps & { landmarkLabel: string };
    const safeLandmarkLabel = boundedLabel('AppShell landmarkLabel', landmarkLabel);
    return (
      <section
        {...native}
        aria-label={safeLandmarkLabel}
        className={classNames('sl-app-shell', className)}
        ref={ref}
      >
        {children}
      </section>
    );
  }
  const { landmark: _landmark, landmarkLabel: _label, ...native } = rest as AppShellProps;
  return (
    <div
      {...native}
      className={classNames('sl-app-shell', className)}
      ref={ref as React.Ref<HTMLDivElement>}
    >
      {children}
    </div>
  );
});

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  readonly children: ReactNode;
  readonly label: string;
}
export const Toolbar = forwardRef<HTMLDivElement, ToolbarProps>(function Toolbar(
  { children, className, label, ...props },
  ref
) {
  const safeLabel = boundedLabel('Toolbar label', label);
  return (
    <div
      {...props}
      aria-label={safeLabel}
      className={classNames('sl-toolbar', className)}
      ref={ref}
      role="toolbar"
    >
      {children}
    </div>
  );
});

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  readonly children: ReactNode;
  readonly title?: string;
}
export function Panel({ children, className, title, ...props }: PanelProps) {
  const safeTitle = optionalBoundedLabel('Panel title', title);
  return (
    <section {...props} className={classNames('sl-panel', className)}>
      {safeTitle === undefined ? null : <h2 className="sl-panel__title">{safeTitle}</h2>}
      {children}
    </section>
  );
}
export interface SplitViewProps extends HTMLAttributes<HTMLDivElement> {
  readonly children: ReactNode;
  readonly direction?: 'horizontal' | 'vertical';
}
export const SplitView = forwardRef<HTMLDivElement, SplitViewProps>(function SplitView(
  { children, className, direction = 'horizontal', ...props },
  ref
) {
  return (
    <div
      {...props}
      className={classNames('sl-split-view', className)}
      data-direction={direction}
      ref={ref}
    >
      {children}
    </div>
  );
});

export interface SelectOption {
  readonly disabled?: boolean;
  readonly id: string;
  readonly label: string;
}
export interface SelectOptionGroup {
  readonly label: string;
  readonly options: readonly SelectOption[];
}
export interface SelectFieldProps extends Omit<
  ComponentPropsWithRef<'select'>,
  'aria-invalid' | 'children'
> {
  readonly error?: string;
  readonly hint?: string;
  readonly label: string;
  readonly options: readonly (SelectOption | SelectOptionGroup)[];
}
function isGroup(option: object): option is SelectOptionGroup {
  return Object.prototype.hasOwnProperty.call(option, 'options');
}

function snapshotSelectOptions(
  entries: readonly (SelectOption | SelectOptionGroup)[]
): readonly (SelectOption | SelectOptionGroup)[] {
  try {
    if (!Array.isArray(entries)) throw new TypeError('not an array');
    const length = collectionLength(entries);
    if (length === 0)
      throw issueCollectionContractError('SelectField options requires at least one item.');
    if (length > maximumCollectionItems)
      throw issueCollectionContractError(
        `SelectField options supports at most ${maximumCollectionItems} items.`
      );
    assertExactDenseArray(entries);
    const flattened: SelectOption[] = [];
    const snapshot: (SelectOption | SelectOptionGroup)[] = [];
    for (let index = 0; index < length; index += 1) {
      const entry = ownDataValue(entries, String(index));
      if (entry === null || typeof entry !== 'object') throw new TypeError('not an item');
      if (isGroup(entry)) {
        assertExactDataRecord(entry, ['label', 'options']);
        const groupLabel = ownDataValue(entry, 'label');
        const groupOptions = ownDataValue(entry, 'options');
        try {
          boundedLabel('SelectField option group labels', groupLabel);
        } catch {
          throw issueCollectionContractError(
            'SelectField option groups require UTF-8 control-safe labels.'
          );
        }
        if (!Array.isArray(groupOptions)) throw new TypeError('invalid group options');
        const groupLength = collectionLength(groupOptions);
        if (groupLength === 0) throw new TypeError('invalid group options');
        if (groupLength > maximumCollectionItems)
          throw issueCollectionContractError(
            `SelectField option groups support at most ${maximumCollectionItems} items.`
          );
        assertExactDenseArray(groupOptions);
        const options: SelectOption[] = [];
        for (let optionIndex = 0; optionIndex < groupLength; optionIndex += 1)
          options.push(
            snapshotSelectOption(ownDataValue(groupOptions, String(optionIndex)) as SelectOption)
          );
        if (flattened.length + options.length > maximumCollectionItems)
          throw issueCollectionContractError(
            `SelectField options supports at most ${maximumCollectionItems} items.`
          );
        flattened.push(...options);
        snapshot.push(
          Object.freeze({ label: groupLabel as string, options: Object.freeze(options) })
        );
        continue;
      }
      const option = snapshotSelectOption(entry as SelectOption);
      if (flattened.length === maximumCollectionItems)
        throw issueCollectionContractError(
          `SelectField options supports at most ${maximumCollectionItems} items.`
        );
      flattened.push(option);
      snapshot.push(option);
    }
    snapshotCollection<SelectOption>('SelectField options', flattened);
    return Object.freeze(snapshot);
  } catch (error) {
    if (isIssuedCollectionContractError(error)) throw error;
    throw issueCollectionContractError(
      'SelectField options must be a stable collection of valid items.'
    );
  }
}

function snapshotSelectOption(option: SelectOption): SelectOption {
  if (option === null || typeof option !== 'object') throw new TypeError('not an option');
  assertExactDataRecord(option, ['id', 'label'], ['disabled']);
  const id = boundedIdentifier('SelectField option IDs', ownDataValue(option, 'id'));
  const label = ownDataValue(option, 'label');
  const disabled = ownDataValueOrUndefined(option, 'disabled');
  try {
    boundedLabel('SelectField option labels', label);
  } catch {
    throw issueCollectionContractError(
      'SelectField option labels must be UTF-8 control-safe strings.'
    );
  }
  if (disabled !== undefined && typeof disabled !== 'boolean')
    throw new TypeError('invalid disabled state');
  return Object.freeze(
    disabled === undefined
      ? { id, label: label as string }
      : { disabled, id, label: label as string }
  );
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { 'aria-describedby': external, className, error, hint, id, label, options, ...props },
  ref
) {
  const safeLabel = boundedLabel('SelectField label', label);
  const safeHint = optionalBoundedLabel('SelectField hint', hint);
  const safeError = optionalBoundedLabel('SelectField error', error);
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const safeOptions = useMemo(() => snapshotSelectOptions(options), [options]);
  const describedBy =
    [
      external,
      safeHint === undefined ? undefined : hintId,
      safeError === undefined ? undefined : errorId
    ]
      .filter((value): value is string => value !== undefined)
      .join(' ') || undefined;
  const renderOption = (option: SelectOption) => (
    <option disabled={option.disabled} key={option.id} value={option.id}>
      {option.label}
    </option>
  );
  return (
    <label className="sl-field" htmlFor={fieldId}>
      <span className="sl-field__label">{safeLabel}</span>
      <select
        {...props}
        aria-describedby={describedBy}
        aria-invalid={safeError === undefined ? undefined : true}
        className={classNames('sl-field__control', className)}
        id={fieldId}
        ref={ref}
      >
        {safeOptions.map((entry, index) =>
          isGroup(entry) ? (
            <optgroup key={`${entry.label}-${index}`} label={entry.label}>
              {entry.options.map(renderOption)}
            </optgroup>
          ) : (
            renderOption(entry)
          )
        )}
      </select>
      {safeHint === undefined ? null : (
        <span className="sl-field__hint" id={hintId}>
          {safeHint}
        </span>
      )}
      {safeError === undefined ? null : (
        <span className="sl-field__error" id={errorId} role="alert">
          {safeError}
        </span>
      )}
    </label>
  );
});

export interface TextareaFieldProps extends Omit<
  ComponentPropsWithRef<'textarea'>,
  'aria-invalid' | 'children'
> {
  readonly error?: string;
  readonly hint?: string;
  readonly label: string;
}
export const TextareaField = forwardRef<HTMLTextAreaElement, TextareaFieldProps>(
  function TextareaField(
    { 'aria-describedby': external, className, error, hint, id, label, ...props },
    ref
  ) {
    const safeLabel = boundedLabel('TextareaField label', label);
    const safeHint = optionalBoundedLabel('TextareaField hint', hint);
    const safeError = optionalBoundedLabel('TextareaField error', error);
    const generated = useId();
    const fieldId = id ?? generated;
    const hintId = `${fieldId}-hint`;
    const errorId = `${fieldId}-error`;
    const describedBy =
      [
        external,
        safeHint === undefined ? undefined : hintId,
        safeError === undefined ? undefined : errorId
      ]
        .filter((value): value is string => value !== undefined)
        .join(' ') || undefined;
    return (
      <label className="sl-field" htmlFor={fieldId}>
        <span className="sl-field__label">{safeLabel}</span>
        <textarea
          {...props}
          aria-describedby={describedBy}
          aria-invalid={safeError === undefined ? undefined : true}
          className={classNames('sl-field__control sl-field__control--textarea', className)}
          id={fieldId}
          ref={ref}
        />
        {safeHint === undefined ? null : (
          <span className="sl-field__hint" id={hintId}>
            {safeHint}
          </span>
        )}
        {safeError === undefined ? null : (
          <span className="sl-field__error" id={errorId} role="alert">
            {safeError}
          </span>
        )}
      </label>
    );
  }
);
