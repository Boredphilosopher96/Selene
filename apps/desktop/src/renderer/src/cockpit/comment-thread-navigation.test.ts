import { describe, expect, it } from 'vitest';

import {
  adjacentThreadId,
  artifactCommentAffordancesVisible,
  selectedThreadIndex
} from './comment-thread-navigation';

const threads = [{ id: 'one' }, { id: 'two' }, { id: 'three' }] as never;

describe('Figma-style artifact thread navigation', () => {
  it('keeps independent pins navigable without a global comment mode', () => {
    expect(selectedThreadIndex(threads, 'two')).toBe(1);
    expect(adjacentThreadId(threads, 'two', 1)).toBe('three');
    expect(adjacentThreadId(threads, 'one', -1)).toBe('three');
  });

  it('does not expose collaboration overlays in Present', () => {
    expect(artifactCommentAffordancesVisible(false)).toBe(true);
    expect(artifactCommentAffordancesVisible(true)).toBe(false);
  });
});
