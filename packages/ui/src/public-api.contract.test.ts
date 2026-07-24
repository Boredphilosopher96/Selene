import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  ButtonProps,
  CardProps,
  IconButtonProps,
  StatusBadgeProps,
  TextFieldProps
} from './index';
import type { SelectFieldProps } from './workspace';
import {
  CollectionContractError,
  OverlayContractError,
  isIssuedCollectionContractError,
  isIssuedOverlayContractError,
  snapshotCollection
} from './workspace-collection-contracts';
import {
  AddIcon,
  Button,
  Card,
  IconButton,
  PlaceholderPanel,
  StatusBadge,
  TextField
} from './index';
import {
  Activity,
  Panel,
  Popover,
  Progress,
  SelectField,
  SegmentedControl,
  Tabs,
  TextareaField,
  Toolbar
} from './workspace';
import { PrototypeFlowCanvas } from './prototype-flow';
import { PrototypeRuntimePreview } from './prototype-runtime';
import { DesignerWorkspace } from './designer-workspace-entry';

describe('@selene/ui public primitive contract', () => {
  it('keeps optional product entrypoints available as named public surfaces', () => {
    expect(PrototypeFlowCanvas).toBeTypeOf('function');
    expect(PrototypeRuntimePreview).toBeTypeOf('function');
    expect(DesignerWorkspace).toBeTypeOf('function');
  });
  it('keeps native ref types on public controls', () => {
    expectTypeOf<ButtonProps['ref']>().toEqualTypeOf<
      React.ComponentPropsWithRef<'button'>['ref']
    >();
    expectTypeOf<IconButtonProps['ref']>().toEqualTypeOf<
      React.ComponentPropsWithRef<'button'>['ref']
    >();
    expectTypeOf<TextFieldProps['ref']>().toEqualTypeOf<
      React.ComponentPropsWithRef<'input'>['ref']
    >();
    expectTypeOf<StatusBadgeProps['ref']>().toEqualTypeOf<
      React.ComponentPropsWithRef<'span'>['ref']
    >();
    expectTypeOf<CardProps['ref']>().toEqualTypeOf<React.Ref<HTMLElement> | undefined>();
    expectTypeOf<SelectFieldProps['ref']>().toEqualTypeOf<
      React.ComponentPropsWithRef<'select'>['ref']
    >();
    expectTypeOf<React.ComponentPropsWithRef<typeof TextareaField>['ref']>().toEqualTypeOf<
      React.ComponentPropsWithRef<'textarea'>['ref']
    >();
    expectTypeOf<React.ComponentPropsWithRef<typeof Tabs>['ref']>().toEqualTypeOf<
      React.ComponentPropsWithRef<'div'>['ref']
    >();
  });

  it('merges consumer classes while retaining invariant foundation classes', () => {
    const button = renderToStaticMarkup(
      createElement(Button, {
        children: 'Save',
        className: 'consumer-button',
        ref: createRef<HTMLButtonElement>()
      })
    );
    const iconButton = renderToStaticMarkup(
      createElement(IconButton, {
        className: 'consumer-icon-button',
        icon: createElement(AddIcon),
        label: 'Add item',
        ref: createRef<HTMLButtonElement>()
      })
    );
    const textField = renderToStaticMarkup(
      createElement(TextField, {
        className: 'consumer-input',
        label: 'Project name',
        ref: createRef<HTMLInputElement>()
      })
    );
    const badge = renderToStaticMarkup(
      createElement(StatusBadge, {
        children: 'Draft',
        className: 'consumer-badge',
        ref: createRef<HTMLSpanElement>(),
        title: 'Draft state'
      })
    );
    const card = renderToStaticMarkup(
      createElement(Card, {
        children: 'Card content',
        className: 'consumer-card',
        ref: createRef<HTMLElement>()
      })
    );

    expect(button).toContain('class="sl-button sl-button--primary consumer-button"');
    expect(iconButton).toContain('class="sl-icon-button consumer-icon-button"');
    expect(textField).toContain('class="sl-text-field__input consumer-input"');
    expect(badge).toContain('class="sl-status-badge sl-status-badge--neutral consumer-badge"');
    expect(badge).toContain('title="Draft state"');
    expect(card).toContain('class="sl-card consumer-card"');
  });

  it('renders only valid select option elements and normalizes unsafe progress values', () => {
    const select = renderToStaticMarkup(
      createElement(SelectField, {
        label: 'Visibility',
        options: [{ id: 'team', label: 'Team only' }],
        ref: createRef<HTMLSelectElement>()
      })
    );
    const progress = renderToStaticMarkup(
      createElement(Progress, {
        label: 'Uploading',
        max: Number.POSITIVE_INFINITY,
        value: Number.NaN
      })
    );
    expect(select).toContain('<select');
    expect(select).toContain('<option value="team">Team only</option>');
    expect(select).not.toContain('>Team only</select>');
    expect(progress).toContain('aria-valuemax="100"');
    expect(progress).toContain('aria-valuenow="0"');
    expect(progress).not.toContain('NaN');
  });

  it('deeply snapshots grouped select options and rejects hostile or blank labels deterministically', () => {
    const grouped = renderToStaticMarkup(
      createElement(SelectField, {
        label: 'Visibility',
        options: [
          {
            label: 'Workspace access',
            options: [{ id: 'team', label: 'Team only' }]
          }
        ]
      })
    );
    expect(grouped).toContain('<optgroup label="Workspace access">');
    expect(grouped).toContain('<option value="team">Team only</option>');

    expect(() =>
      renderToStaticMarkup(
        createElement(SelectField, {
          label: 'Visibility',
          options: [{ id: 'team', label: '   ' }]
        })
      )
    ).toThrow('SelectField option labels must be UTF-8 control-safe strings.');

    const hostile = new Proxy([] as SelectFieldProps['options'], {
      get() {
        throw new Error('hostile collection');
      }
    });
    expect(() =>
      renderToStaticMarkup(createElement(SelectField, { label: 'Visibility', options: hostile }))
    ).toThrow('SelectField options requires at least one item.');
  });

  it('bounds public labels and snapshots proxy-backed tab aggregates without enumeration', () => {
    expect(() =>
      renderToStaticMarkup(createElement(Toolbar, { children: 'Actions', label: '   ' }))
    ).toThrow('Toolbar label must be a non-blank UTF-8 control-safe string of at most 160 bytes.');
    expect(() =>
      renderToStaticMarkup(createElement(Panel, { children: 'Content', title: 'x'.repeat(161) }))
    ).toThrow('Panel title must be a non-blank UTF-8 control-safe string of at most 160 bytes.');
    expect(() => renderToStaticMarkup(createElement(Activity, { label: '' }))).toThrow(
      'Activity label must be a non-blank UTF-8 control-safe string of at most 160 bytes.'
    );

    const tab = new Proxy(
      { id: 'overview', label: 'Overview', panel: createElement('p', undefined, 'Summary') },
      {
        ownKeys() {
          throw new Error('collection snapshots must not enumerate caller aggregates');
        }
      }
    );
    expect(() =>
      renderToStaticMarkup(createElement(Tabs, { label: 'Workspace views', tabs: [tab] }))
    ).toThrow('Tabs must be a stable collection of valid items.');

    const unsafeIdentifier = new Proxy(
      { id: 'not safe', label: 'Overview', panel: 'Summary' },
      { get: Reflect.get }
    );
    expect(() =>
      renderToStaticMarkup(
        createElement(Tabs, { label: 'Workspace views', tabs: [unsafeIdentifier] })
      )
    ).toThrow('Tabs item IDs must be a safe identifier of at most 64 characters.');
  });

  it('uses UTF-8 byte bounds, rejects controls, and caps descriptor-snapshotted collections', () => {
    expect(() => renderToStaticMarkup(createElement(Activity, { label: 'x'.repeat(513) }))).toThrow(
      'Activity label must be a non-blank UTF-8 control-safe string of at most 160 bytes.'
    );
    expect(() =>
      renderToStaticMarkup(createElement(Panel, { children: 'x', title: '🙂'.repeat(41) }))
    ).toThrow('Panel title must be a non-blank UTF-8 control-safe string of at most 160 bytes.');
    expect(() =>
      renderToStaticMarkup(createElement(Toolbar, { children: 'x', label: 'safe\u0000unsafe' }))
    ).toThrow('Toolbar label must be a non-blank UTF-8 control-safe string of at most 160 bytes.');
    expect(() =>
      renderToStaticMarkup(createElement(IconButton, { icon: '×', label: 'safe\u202Eunsafe' }))
    ).toThrow(
      'IconButton label must be a non-blank UTF-8 control-safe string of at most 160 bytes.'
    );
    expect(() =>
      renderToStaticMarkup(createElement(TextField, { label: 'safe\ud800unsafe' }))
    ).toThrow(
      'TextField label must be a non-blank UTF-8 control-safe string of at most 160 bytes.'
    );
    expect(() =>
      renderToStaticMarkup(createElement(PlaceholderPanel, { title: 'safe\u2028unsafe' }))
    ).toThrow(
      'PlaceholderPanel title must be a non-blank UTF-8 control-safe string of at most 160 bytes.'
    );
    const getterBacked = {
      get id() {
        throw new Error('must not invoke item getters');
      },
      label: 'Overview',
      panel: 'Summary'
    } as unknown as import('./workspace').TabItem;
    expect(() =>
      renderToStaticMarkup(createElement(Tabs, { label: 'Workspace views', tabs: [getterBacked] }))
    ).toThrow('Tabs must be a stable collection of valid items.');
    expect(() =>
      renderToStaticMarkup(
        createElement(Tabs, {
          label: 'Workspace views',
          tabs: [
            Object.assign(Object.create(null), { id: 'overview', label: 'Overview', panel: 'x' })
          ]
        })
      )
    ).not.toThrow();
    expect(() =>
      renderToStaticMarkup(
        createElement(Tabs, {
          label: 'Workspace views',
          tabs: [
            Object.assign(Object.create({ inherited: true }), {
              id: 'overview',
              label: 'Overview',
              panel: 'x'
            })
          ]
        })
      )
    ).toThrow('Tabs must be a stable collection of valid items.');
    const tooMany = Array.from({ length: 101 }, (_, index) => ({
      id: `tab-${index}`,
      label: `Tab ${index}`,
      panel: index
    }));
    expect(() =>
      renderToStaticMarkup(createElement(Tabs, { label: 'Workspace views', tabs: tooMany }))
    ).toThrow('Tabs supports at most 100 items.');
    const exactSelectOptions = [{ id: 'one', label: 'One' }];
    Object.defineProperty(exactSelectOptions, 'hidden', { value: true });
    expect(() =>
      renderToStaticMarkup(
        createElement(SelectField, { label: 'Exact', options: exactSelectOptions })
      )
    ).toThrow('SelectField options must be a stable collection of valid items.');
    expect(() =>
      renderToStaticMarkup(
        createElement(SelectField, {
          label: 'Exact',
          options: [
            { label: 'Group', options: [{ id: 'one', label: 'One', extra: true }] }
          ] as unknown as SelectFieldProps['options']
        })
      )
    ).toThrow('SelectField options must be a stable collection of valid items.');
  });

  it('normalizes forged contract errors and bounds hostile collection work before inspection', () => {
    const forgedCollectionError = Object.create(CollectionContractError.prototype);
    const forgedOverlayError = Object.create(OverlayContractError.prototype);
    class HostileCollectionError extends CollectionContractError {}
    class HostileOverlayError extends OverlayContractError {}
    expect(isIssuedCollectionContractError(forgedCollectionError)).toBe(false);
    expect(isIssuedOverlayContractError(forgedOverlayError)).toBe(false);
    expect(isIssuedCollectionContractError(new CollectionContractError('issued'))).toBe(false);
    expect(isIssuedOverlayContractError(new OverlayContractError('issued'))).toBe(false);
    expect(isIssuedCollectionContractError(new HostileCollectionError('issued'))).toBe(false);
    expect(isIssuedOverlayContractError(new HostileOverlayError('issued'))).toBe(false);

    const huge = new Proxy([{ id: 'one', label: 'One' }], {
      getOwnPropertyDescriptor(_target, key) {
        if (key === 'length')
          return { configurable: false, enumerable: false, value: 101, writable: true };
        throw new Error('must not inspect huge collection entries');
      },
      ownKeys() {
        throw new Error('must not enumerate huge collection');
      }
    });
    expect(() =>
      snapshotCollection('Hostile', huge as unknown as readonly { id: string; label: string }[])
    ).toThrow('Hostile supports at most 100 items.');

    expect(() =>
      snapshotCollection('Forged', [{ id: 'one', label: 'One' }], () => {
        throw forgedCollectionError;
      })
    ).toThrow('Forged must be a stable collection of valid items.');

    const constructorTrap = new Proxy([{ id: 'one', label: 'One' }], {
      getOwnPropertyDescriptor(_target, key) {
        if (key === 'length')
          return { configurable: false, enumerable: false, value: 1, writable: true };
        throw new CollectionContractError('forged hostile text');
      }
    });
    expect(() =>
      snapshotCollection(
        'Constructor trap',
        constructorTrap as unknown as readonly { id: string; label: string }[]
      )
    ).toThrow('Constructor trap must be a stable collection of valid items.');
  });

  it('defines controlled popover contracts before DOM work', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(Popover, {
          children: 'Details',
          contentLabel: 'Details',
          open: 'yes' as never,
          triggerText: 'Open details'
        })
      )
    ).toThrow('Popover open must be a boolean.');
    expect(() =>
      renderToStaticMarkup(
        createElement(Popover, {
          children: 'Details',
          contentLabel: 'Details',
          placement: 'sideways' as never,
          triggerText: 'Open details'
        })
      )
    ).toThrow('Popover placement must be auto, above, or below.');
    expect(() =>
      renderToStaticMarkup(
        createElement(SegmentedControl, {
          label: 'Modes',
          options: [
            { id: 'one', label: 'One' },
            { id: 'two', label: 'Two' }
          ],
          value: 'one',
          onValueChange: () => undefined
        })
      )
    ).not.toThrow();
  });
});
