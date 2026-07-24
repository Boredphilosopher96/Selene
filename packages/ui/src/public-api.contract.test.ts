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
import { AddIcon, Button, Card, IconButton, StatusBadge, TextField } from './index';

describe('@selene/ui public primitive contract', () => {
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
});
