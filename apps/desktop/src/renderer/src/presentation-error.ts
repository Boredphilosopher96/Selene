export type PreviewInteractionFailure = 'select-node' | 'trigger-action';

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
    /\b(?:host|provider|hostname|endpoint|api[ _-]?key|access[ _-]?token|model[ _-]?id|openai|anthropic|bedrock|vertex|azure)\b/iu.test(
      value
    ) ||
    /\b(?:ENOENT|EPERM|EACCES|ECONNREFUSED|spawn|exit code)\b/iu.test(value) ||
    /\bat\s+(?:\S+\s+\()?[^)\s]+:\d+:\d+\)?/u.test(value)
  );
}

export function safeDesignerNotice(
  value: string,
  fallback = 'Try the canvas action again.'
): string {
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
