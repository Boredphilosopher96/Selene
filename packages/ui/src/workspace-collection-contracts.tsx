import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { boundedLabel } from './label-contract';

const issuedCollectionContractErrors = new WeakSet<object>();
const issuedOverlayContractErrors = new WeakSet<object>();

export class CollectionContractError extends Error {
  override name = 'CollectionContractError';
}

export class OverlayContractError extends Error {
  override name = 'OverlayContractError';
}

export function issueCollectionContractError(message: string): CollectionContractError {
  const error = new CollectionContractError(message);
  issuedCollectionContractErrors.add(error);
  return error;
}

export function issueOverlayContractError(message: string): OverlayContractError {
  const error = new OverlayContractError(message);
  issuedOverlayContractErrors.add(error);
  return error;
}

export function isIssuedCollectionContractError(error: unknown): error is CollectionContractError {
  return typeof error === 'object' && error !== null && issuedCollectionContractErrors.has(error);
}

export function isIssuedOverlayContractError(error: unknown): error is OverlayContractError {
  return typeof error === 'object' && error !== null && issuedOverlayContractErrors.has(error);
}

const maximumCollectionIdLength = 64;
const maximumIdentifierCodeUnits = 256;
export const maximumCollectionItems = 100;
const safeId = new RegExp(`^[A-Za-z][A-Za-z0-9_-]{0,${maximumCollectionIdLength - 1}}$`);

export function boundedIdentifier(name: string, value: unknown): string {
  const raw = value;
  if (typeof raw !== 'string' || raw.length > maximumIdentifierCodeUnits || !safeId.test(raw))
    throw issueCollectionContractError(
      `${name} must be a safe identifier of at most ${maximumCollectionIdLength} characters.`
    );
  return raw;
}

export function ownDataValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !('value' in descriptor)) throw new TypeError(`missing ${key}`);
  return descriptor.value;
}

export function assertExactDenseArray(entries: readonly unknown[]): void {
  const length = collectionLength(entries);
  if (length > maximumCollectionItems)
    throw new TypeError(`collection supports at most ${maximumCollectionItems} items`);
  if (
    Object.getPrototypeOf(entries) !== Array.prototype ||
    Object.getOwnPropertySymbols(entries).length
  )
    throw new TypeError('unapproved collection prototype');
  const names = Object.getOwnPropertyNames(entries);
  if (names.length !== length + 1 || !names.includes('length'))
    throw new TypeError('sparse collection');
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, String(index));
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !descriptor.enumerable ||
      !descriptor.configurable ||
      !descriptor.writable
    )
      throw new TypeError('invalid collection entry');
  }
}

export function assertExactDataRecord(
  record: object,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const prototype = Object.getPrototypeOf(record);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(record).length
  )
    throw new TypeError('unapproved item prototype');
  const allowed = new Set([...required, ...optional]);
  const names = Object.getOwnPropertyNames(record);
  if (names.length > allowed.size || names.some((key) => !allowed.has(key)))
    throw new TypeError('extra item field');
  for (const key of required) if (!names.includes(key)) throw new TypeError(`missing ${key}`);
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
      throw new TypeError('invalid item descriptor');
  }
}

export function snapshotCollection<
  T extends { readonly disabled?: boolean; readonly id: string; readonly label: string }
>(
  name: string,
  entries: readonly T[],
  extra?: (entry: object) => Readonly<Record<string, unknown>>
): readonly T[] {
  try {
    if (!Array.isArray(entries)) throw new TypeError('not an array');
    const length = collectionLength(entries);
    if (length === 0) throw issueCollectionContractError(`${name} requires at least one item.`);
    if (length > maximumCollectionItems)
      throw issueCollectionContractError(
        `${name} supports at most ${maximumCollectionItems} items.`
      );
    assertExactDenseArray(entries);
    const ids = new Set<string>();
    const snapshot: T[] = [];
    for (let index = 0; index < length; index += 1) {
      const entry = ownDataValue(entries, String(index));
      if (entry === null || typeof entry !== 'object') throw new TypeError('not an item');
      assertExactDataRecord(
        entry,
        ['id', 'label'],
        extra === undefined ? ['disabled'] : ['disabled', 'panel']
      );
      const id = boundedIdentifier(`${name} item IDs`, ownDataValue(entry, 'id'));
      const label = ownDataValue(entry, 'label');
      const disabled = ownDataValueOrUndefined(entry, 'disabled');
      try {
        boundedLabel(`${name} item labels`, label);
      } catch {
        throw issueCollectionContractError(
          `${name} items require unique safe IDs and UTF-8 control-safe labels.`
        );
      }
      if (ids.has(id))
        throw issueCollectionContractError(
          `${name} items require unique safe IDs and UTF-8 control-safe labels.`
        );
      if (disabled !== undefined && typeof disabled !== 'boolean')
        throw new TypeError('invalid disabled state');
      ids.add(id);
      const fields = extra?.(entry) ?? {};
      snapshot.push(
        Object.freeze(
          disabled === undefined ? { id, label, ...fields } : { disabled, id, label, ...fields }
        ) as T
      );
    }
    if (!snapshot.some((entry) => !entry.disabled))
      throw issueCollectionContractError(`${name} requires at least one enabled item.`);
    return Object.freeze(snapshot);
  } catch (error) {
    if (isIssuedCollectionContractError(error)) throw error;
    throw issueCollectionContractError(`${name} must be a stable collection of valid items.`);
  }
}

export function ownDataValueOrUndefined(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw new TypeError(`accessor ${key}`);
  return descriptor.value;
}

export function collectionLength(entries: readonly unknown[]): number {
  const length = ownDataValue(entries, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
    throw new TypeError('invalid collection length');
  return length;
}

export function useLatest<T>(value: T): React.RefObject<T> {
  const latest = useRef(value);
  latest.current = value;
  return latest;
}

export function useControllableValue<T>(
  value: T | undefined,
  defaultValue: T,
  onChange: ((next: T) => void) | undefined
): readonly [T, (next: T) => void] {
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const valueRef = useLatest(value);
  const onChangeRef = useLatest(onChange);
  const request = useCallback((next: T) => {
    if (valueRef.current === undefined) setUncontrolled(next);
    onChangeRef.current?.(next);
  }, []);
  return [value ?? uncontrolled, request];
}

/** Controlled keyboard focus waits for a host-prop acknowledgement, never elapsed time. */
export function useAcknowledgedSelectionFocus<
  T extends { readonly disabled?: boolean; readonly id: string }
>(
  items: readonly T[],
  selected: string,
  controlled: boolean,
  refs: React.RefObject<(HTMLButtonElement | null)[]>
) {
  const intent = useRef<{ readonly generation: number; readonly id: string } | null>(null);
  const observed = useRef(selected);
  const generation = useRef(0);
  useLayoutEffect(() => {
    if (observed.current !== selected) {
      observed.current = selected;
      generation.current += 1;
    }
    const pending = intent.current;
    if (pending === null) return;
    if (selected === pending.id) {
      const currentIndex = items.findIndex((item) => item.id === pending.id);
      refs.current[currentIndex]?.focus();
      intent.current = null;
    } else if (generation.current > pending.generation) {
      intent.current = null;
    }
  }, [items, refs, selected]);
  return (index: number) => {
    const item = items[index];
    if (item === undefined || item.disabled || item.id === selected) return;
    if (!controlled) {
      refs.current[index]?.focus();
      return;
    }
    intent.current = { generation: generation.current, id: item.id };
  };
}
