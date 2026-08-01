import type { ReviewThread } from '../../../shared/designer-api';

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

/** Stable display text avoids locale-dependent visual-story snapshots. */
export function formatThreadTimestamp(value: string): string {
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/** Local attribution IDs are durable host identity, not useful designer-facing names. */
export function formatThreadAuthor(value: string): string {
  const author = value.trim();
  if (/^local-designer(?:-|$)/u.test(author)) return 'You';
  return author || 'Unknown teammate';
}
