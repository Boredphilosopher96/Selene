import { describe, expect, it } from 'vitest';

import { prototypeGraphFixture } from '@selene/core';

import { layoutPrototypeWires } from './prototype-flow-canvas';

describe('prototype flow wire layout', () => {
  it('routes overlay, back, and timeout edges deterministically without label collisions', () => {
    const bounds = { minX: -40, minY: -80, width: 920, height: 560 };
    const first = layoutPrototypeWires(prototypeGraphFixture, bounds);
    const second = layoutPrototypeWires(prototypeGraphFixture, bounds);
    const firstLayout = [...first.entries()];

    expect(firstLayout).toEqual([...second.entries()]);
    expect(first.get('save-order')?.label.text).toContain('open-overlay');
    expect(first.get('cancel-order')?.label.text).toContain('back');
    expect(first.get('expire-order-draft')?.label.text).toContain('reset-flow');
    expect(new Set(firstLayout.map(([, layout]) => layout.path)).size).toBe(firstLayout.length);

    const labels = [...first.values()].map((item) => ({
      x: item.label.x,
      y: item.label.y - item.label.height,
      width: item.label.width,
      height: item.label.height
    }));
    for (const [index, label] of labels.entries()) {
      expect(label.x).toBeGreaterThanOrEqual(0);
      expect(label.y).toBeGreaterThanOrEqual(0);
      expect(label.x + label.width).toBeLessThanOrEqual(bounds.width);
      expect(label.y + label.height).toBeLessThanOrEqual(bounds.height);
      for (const other of labels.slice(index + 1))
        expect(
          label.x < other.x + other.width &&
            label.x + label.width > other.x &&
            label.y < other.y + other.height &&
            label.y + label.height > other.y
        ).toBe(false);
    }
    const nodeBoxes = prototypeGraphFixture.nodes.map((node) => ({
      x: node.position.x - bounds.minX - 8,
      y: node.position.y - bounds.minY - 8,
      width: 196,
      height: 160 + node.ports.length * 29
    }));
    for (const label of labels)
      for (const node of nodeBoxes)
        expect(
          label.x < node.x + node.width &&
            label.x + label.width > node.x &&
            label.y < node.y + node.height &&
            label.y + label.height > node.y
        ).toBe(false);
  });
});
