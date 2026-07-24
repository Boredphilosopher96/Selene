import { describe, expect, it } from 'vitest';

import { prototypeGraphFixture } from '@selene/core';

import { layoutPrototypeWires } from './prototype-flow-canvas';

describe('prototype flow wire layout', () => {
  it('routes overlay, back, and timeout edges deterministically without label collisions', () => {
    const bounds = { minX: 40, minY: 40 };
    const first = layoutPrototypeWires(prototypeGraphFixture, bounds);
    const second = layoutPrototypeWires(prototypeGraphFixture, bounds);
    const firstLayout = [...first.entries()];

    expect(firstLayout).toEqual([...second.entries()]);
    expect(first.get('save-order')?.label.text).toContain('open-overlay');
    expect(first.get('cancel-order')?.label.text).toContain('back');
    expect(first.get('expire-order-draft')?.label.text).toContain('reset-flow');

    const labels = [...first.values()].map((item) => ({
      x: item.label.x,
      y: item.label.y,
      width: Math.max(72, item.label.text.length * 6.25),
      height: 16
    }));
    for (const [index, label] of labels.entries()) {
      for (const other of labels.slice(index + 1))
        expect(
          label.x < other.x + other.width &&
            label.x + label.width > other.x &&
            label.y < other.y + other.height &&
            label.y + label.height > other.y
        ).toBe(false);
    }
  });
});
