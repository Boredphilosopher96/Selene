import { useId, type ComponentPropsWithRef } from 'react';

import { classNames } from './class-names';
import { boundedLabel, optionalBoundedLabel } from './label-contract';
import './foundation.css';

export interface TextFieldProps extends Omit<
  ComponentPropsWithRef<'input'>,
  'aria-invalid' | 'children'
> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly id?: string;
}

/** A labelled input that keeps hint and error text connected to the control. */
export function TextField({
  'aria-describedby': externalDescribedBy,
  className,
  error,
  hint,
  id,
  label,
  ref,
  ...inputProps
}: TextFieldProps) {
  const safeLabel = boundedLabel('TextField label', label);
  const safeHint = optionalBoundedLabel('TextField hint', hint);
  const safeError = optionalBoundedLabel('TextField error', error);
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy =
    [
      externalDescribedBy,
      safeHint === undefined ? undefined : hintId,
      safeError === undefined ? undefined : errorId
    ]
      .filter((value): value is string => value !== undefined)
      .join(' ') || undefined;

  return (
    <label className="sl-text-field" htmlFor={inputId}>
      <span className="sl-text-field__label">{safeLabel}</span>
      <input
        {...inputProps}
        aria-describedby={describedBy}
        aria-invalid={safeError === undefined ? undefined : true}
        className={classNames('sl-text-field__input', className)}
        id={inputId}
        ref={ref}
      />
      {safeHint === undefined ? null : (
        <span className="sl-text-field__hint" id={hintId}>
          {safeHint}
        </span>
      )}
      {safeError === undefined ? null : (
        <span className="sl-text-field__error" id={errorId} role="alert">
          {safeError}
        </span>
      )}
    </label>
  );
}
