import { describe, expect, it } from 'vitest';

import {
  adjacentThreadId,
  artifactCommentAffordancesVisible,
  formatThreadAuthor,
  formatThreadTimestamp,
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

  it('keeps @AI text in the human discussion rather than creating an AI request', () => {
    expect(formatThreadTimestamp('2026-07-26T18:30:00.000Z')).toBe('2026-07-26 18:30:00 UTC');
  });

  it('presents durable local attribution as a human collaborator label', () => {
    expect(formatThreadAuthor('local-designer-b381492b')).toBe('You');
    expect(formatThreadAuthor('Ari')).toBe('Ari');
    expect(formatThreadAuthor(' ')).toBe('Unknown teammate');
  });
});
