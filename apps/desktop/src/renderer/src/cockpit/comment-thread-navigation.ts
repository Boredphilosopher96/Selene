import type { ReviewThread } from '../../../shared/designer-api';

const maximumTranscriptReplies = 12;
const maximumTranscriptCharacters = 6_000;

/** Presentation is a clean prototype surface: no collaboration affordances leak into it. */
export function artifactCommentAffordancesVisible(presenting: boolean): boolean {
  return !presenting;
}

export function selectedThreadIndex(
  threads: readonly ReviewThread[],
  selectedThreadId: string | undefined
): number {
  return selectedThreadId === undefined
    ? -1
    : threads.findIndex((thread) => thread.id === selectedThreadId);
}

/** Cycles through the same immutable snapshot used by the visible pin layer. */
export function adjacentThreadId(
  threads: readonly ReviewThread[],
  selectedThreadId: string | undefined,
  direction: -1 | 1
): string | undefined {
  const index = selectedThreadIndex(threads, selectedThreadId);
  if (index < 0 || threads.length < 2) return undefined;
  return threads[(index + direction + threads.length) % threads.length]?.id;
}

/** AI work is explicit in a human thread; ordinary @ text does not trigger an agent. */
export function hasAiMention(body: string): boolean {
  return /(^|[\s([{])@ai\b/i.test(body);
}

/** Stable display text avoids locale-dependent visual-story snapshots. */
export function formatThreadTimestamp(value: string): string {
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/** Bounded, human-readable context for an independent agent request. */
export function boundedThreadTranscript(thread: ReviewThread): string {
  const messages = [
    `${thread.author}: ${thread.body}`,
    ...thread.replies
      .slice(-maximumTranscriptReplies)
      .map((reply) => `${reply.author}: ${reply.body}`)
  ];
  return messages.join('\n').slice(0, maximumTranscriptCharacters);
}

/**
 * Agent transport diagnostics can include terminal controls, paths, or provider
 * details. Keep those in host diagnostics and give a designer one safe recovery
 * action in the artifact thread instead.
 */
export function threadAiFailureMessage(_error: unknown): string {
  return 'AI request could not be created. Check the selected agent and try Ask AI again.';
}
