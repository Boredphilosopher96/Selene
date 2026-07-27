import { describe, expect, it } from 'vitest';

import {
  adjacentThreadId,
  artifactCommentAffordancesVisible,
  boundedThreadTranscript,
  formatThreadTimestamp,
  hasAiMention,
  selectedThreadIndex,
  threadAiFailureMessage
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

  it('requires an explicit mention and bounds a transcript for the separate AI request', () => {
    expect(hasAiMention('Please @AI adjust this state')).toBe(true);
    expect(hasAiMention('email@ai.example')).toBe(false);
    expect(formatThreadTimestamp('2026-07-26T18:30:00.000Z')).toBe('2026-07-26 18:30:00 UTC');
    expect(
      boundedThreadTranscript({
        id: 'thread-1',
        author: 'Ari',
        body: 'Root comment',
        replies: [
          { id: 'reply-1', author: 'Bea', body: 'Reply', createdAt: '2026-07-26T18:30:00.000Z' }
        ]
      } as never)
    ).toBe('Ari: Root comment\nBea: Reply');
  });

  it('keeps provider diagnostics out of the visible human thread', () => {
    expect(threadAiFailureMessage(new Error('\u001b[31m/private/token\u001b[0m'))).toBe(
      'AI request could not be created. Check the selected agent and try Ask AI again.'
    );
  });
});
