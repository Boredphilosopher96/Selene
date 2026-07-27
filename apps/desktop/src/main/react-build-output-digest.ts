import { createHash } from 'node:crypto';

export interface ReactBuildOutput {
  readonly code: string;
  readonly css?: string;
  readonly sourceMap?: string;
}

/**
 * Binds the exact emitted preview payload without routing large Vite bundles
 * through the bounded canonical-data serializer. Each UTF-8 field is framed so
 * code, CSS, and source-map boundaries cannot be confused.
 */
export function digestReactBuildOutput(output: ReactBuildOutput): string {
  const hash = createHash('sha256').update('selene-react-build-output/v1\0');
  for (const [field, value] of [
    ['code', output.code],
    ['css', output.css ?? ''],
    ['sourceMap', output.sourceMap ?? '']
  ] as const) {
    const bytes = Buffer.byteLength(value, 'utf8');
    hash.update(`${field}\0${bytes}\0`, 'utf8').update(value, 'utf8');
  }
  return hash.digest('hex');
}
