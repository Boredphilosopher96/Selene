const cssNumber = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const legacyRgb = new RegExp(
  `^rgba?\\(\\s*(${cssNumber})\\s*,\\s*(${cssNumber})\\s*,\\s*(${cssNumber})(?:\\s*,\\s*(${cssNumber}))?\\s*\\)$`,
  'i'
);
const modernRgb = new RegExp(
  `^rgba?\\(\\s*(${cssNumber})\\s+(${cssNumber})\\s+(${cssNumber})(?:\\s*\\/\\s*(${cssNumber}))?\\s*\\)$`,
  'i'
);

/** Parses CSSOM numeric RGB(A) output without treating a missing alpha as NaN. */
export function relativeLuminance(color: string): number | undefined {
  const normalized = color.trim();
  const match = normalized.match(legacyRgb) ?? normalized.match(modernRgb);
  if (match === null) return undefined;
  const [, redText, greenText, blueText, alphaText] = match;
  if (redText === undefined || greenText === undefined || blueText === undefined) return undefined;
  const red = Number(redText);
  const green = Number(greenText);
  const blue = Number(blueText);
  // The optional capture is deliberately defaulted before numeric coercion.
  const alpha = alphaText === undefined ? 1 : Number(alphaText);
  if (
    !Number.isFinite(red) ||
    !Number.isFinite(green) ||
    !Number.isFinite(blue) ||
    !Number.isFinite(alpha) ||
    red < 0 ||
    red > 255 ||
    green < 0 ||
    green > 255 ||
    blue < 0 ||
    blue > 255 ||
    alpha < 0.98 ||
    alpha > 1
  )
    return undefined;
  const linear = (channel: number) => {
    const normalizedChannel = channel / 255;
    return normalizedChannel <= 0.04045
      ? normalizedChannel / 12.92
      : ((normalizedChannel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}
