class LabelContractError extends Error {
  override name = 'LabelContractError';
}

export const maximumLabelBytes = 160;
/** Keep hostile strings out of trim, Unicode matching, and TextEncoder. */
export const maximumLabelCodeUnits = 512;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    const next = value.charCodeAt(index + 1);
    if (unit > 0xdbff || next < 0xdc00 || next > 0xdfff) return true;
    index += 1;
  }
  return false;
}

/** Reject empty, invisible-control-bearing, malformed, or oversized public text before the DOM. */
export function boundedLabel(name: string, value: unknown): string {
  const raw = value;
  if (
    typeof raw !== 'string' ||
    raw.length > maximumLabelCodeUnits ||
    raw.trim() === '' ||
    /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(raw) ||
    hasUnpairedSurrogate(raw) ||
    utf8ByteLength(raw) > maximumLabelBytes
  )
    throw new LabelContractError(
      `${name} must be a non-blank UTF-8 control-safe string of at most ${maximumLabelBytes} bytes.`
    );
  return raw;
}

export function optionalBoundedLabel(name: string, value: unknown): string | undefined {
  return value === undefined ? undefined : boundedLabel(name, value);
}
