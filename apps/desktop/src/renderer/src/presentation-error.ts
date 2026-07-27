export type PreviewInteractionFailure = 'select-node' | 'trigger-action';
export type DesignerErrorSurface =
  | 'workspace'
  | 'preview'
  | 'agent'
  | 'review'
  | 'handoff'
  | 'toolbar'
  | 'scenario'
  | 'canvas'
  | 'publish';

export type DesignerErrorCategory =
  'cancelled' | 'recovery' | 'unavailable' | 'conflict' | 'unknown';

const surfaceAction: Readonly<Record<DesignerErrorSurface, string>> = {
  workspace: 'Try again, or reopen the project.',
  preview: 'Try again, or refresh the preview.',
  agent: 'Try again, or choose another configured agent.',
  review: 'Try again. Your saved discussion remains available.',
  handoff: 'Try again after reviewing the handoff requirements.',
  toolbar: 'Try again from the workspace toolbar.',
  scenario: 'Try again, or choose a different saved scenario.',
  canvas: 'Try again, or refresh the canvas.',
  publish: 'Try again after reviewing the publish details.'
};

const surfaceFallback: Readonly<Record<DesignerErrorSurface, string>> = {
  workspace: 'We could not update this workspace. Try again, or reopen the project.',
  preview: 'We could not refresh the preview. Try again, or refresh the preview.',
  agent: 'We could not complete the AI change. Try again, or choose another configured agent.',
  review:
    'We could not save the review update. Try again; your saved discussion remains available.',
  handoff:
    'We could not prepare the developer handoff. Try again after reviewing the requirements.',
  toolbar: 'We could not update that workspace control. Try again from the workspace toolbar.',
  scenario: 'We could not start that saved scenario. Try again, or choose a different scenario.',
  canvas: 'We could not save that canvas change. Try again, or refresh the canvas.',
  publish: 'We could not complete the publish step. Try again after reviewing the publish details.'
};

/** Classifies host failures without allowing host wording into renderer UI. */
export function classifyDesignerError(error: unknown): DesignerErrorCategory {
  const detail = error instanceof Error ? error.message.toLowerCase() : '';
  if (/\b(cancel(?:led|ed)?|abort(?:ed)?)\b/u.test(detail)) return 'cancelled';
  if (/\b(recovery|crash)\b/u.test(detail)) return 'recovery';
  if (/\b(already|conflict|stale|changed|in progress)\b/u.test(detail)) return 'conflict';
  if (/\b(unavailable|unsupported|not configured|not found|incompatible)\b/u.test(detail))
    return 'unavailable';
  return 'unknown';
}

/**
 * Bounded renderer presentation boundary. Never render `Error.message`: host,
 * provider, filesystem, URL, stack, and terminal details stay diagnostic-only.
 */
export function presentDesignerError(error: unknown, surface: DesignerErrorSurface): string {
  const action = surfaceAction[surface];
  switch (classifyDesignerError(error)) {
    case 'cancelled':
      return `That ${surface} step was cancelled. ${action}`;
    case 'recovery':
      return 'Crash recovery is protecting this workspace. Resume previews, then try again.';
    case 'conflict':
      return `This workspace changed while the action was running. ${action}`;
    case 'unavailable':
      return `That ${surface} action is not available right now. ${action}`;
    default:
      return surfaceFallback[surface];
  }
}

export function previewInteractionFailureNotice(operation: PreviewInteractionFailure): string {
  return operation === 'select-node'
    ? 'Could not select that preview element. Try again or refresh the preview.'
    : 'Could not run that prototype action. Try again or refresh the preview.';
}

function containsPrivateHostDetails(value: string): boolean {
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31);
  });
  return (
    value.length === 0 ||
    value.includes(String.fromCharCode(27)) ||
    hasControlCharacter ||
    value.includes(String.fromCharCode(127)) ||
    /(?:^|[\s"'(])(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/u.test(value) ||
    /(?:node_modules|(?:https?|file|ssh|git|wss?):\/\/|localhost|\b\d{1,3}(?:\.\d{1,3}){3}\b|(?:[a-z0-9-]+\.)+[a-z]{2,})/iu.test(
      value
    ) ||
    /\b(?:hostname|endpoint|api[ _-]?key|access[ _-]?token|model[ _-]?id|openai|anthropic|bedrock|vertex|azure)\b/iu.test(
      value
    ) ||
    /\b(?:ENOENT|EPERM|EACCES|ECONNREFUSED|spawn|exit code)\b/iu.test(value) ||
    /\bat\s+(?:\S+\s+\()?[^)\s]+:\d+:\d+\)?/u.test(value)
  );
}

export function safeDesignerNotice(
  value: unknown,
  fallback = 'Try the canvas action again.'
): string {
  if (typeof value !== 'string') return safeDesignerNotice(fallback);
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (containsPrivateHostDetails(value) || containsPrivateHostDetails(compact)) {
    const compactFallback = fallback.replace(/\s+/gu, ' ').trim();
    return !containsPrivateHostDetails(fallback) &&
      !containsPrivateHostDetails(compactFallback) &&
      compactFallback.length <= 180
      ? compactFallback
      : 'Try the canvas action again.';
  }
  return compact.length > 180 ? `${compact.slice(0, 177).trimEnd()}…` : compact;
}
