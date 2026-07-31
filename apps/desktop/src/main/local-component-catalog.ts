import { createHash } from 'node:crypto';
import { posix as path } from 'node:path';

import type { ReactSourceWorkspace } from '@selene/core';

export interface LocalCatalogComponent {
  readonly id: string;
  readonly storyId: string;
  readonly path: string;
  readonly exportName: string;
}

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;

export function localCatalogDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function componentName(sourcePath: string, exportName: string): string {
  const name =
    exportName === 'default'
      ? path.basename(sourcePath, path.extname(sourcePath)) || 'Component'
      : exportName;
  return name.length <= 120
    ? name
    : `${name.slice(0, 111)}-${localCatalogDigest(name).slice(0, 8)}`;
}

/** Stable component/story identity shared by local previews and generated CSF. */
export function deriveLocalCatalogComponents(
  workspace: Pick<ReactSourceWorkspace, 'nodes'>
): readonly LocalCatalogComponent[] {
  const unique = new Map<string, { readonly path: string; readonly exportName: string }>();
  for (const node of workspace.nodes) {
    if (!identifier.test(node.exportName) && node.exportName !== 'default') continue;
    unique.set(`${node.path}\u0000${node.exportName}`, {
      path: node.path,
      exportName: node.exportName
    });
  }
  const candidates = [...unique.values()].sort((left, right) =>
    `${left.path}\u0000${left.exportName}`.localeCompare(
      `${right.path}\u0000${right.exportName}`,
      'en'
    )
  );
  const names = new Map<string, number>();
  return candidates.map((candidate) => {
    const name = componentName(candidate.path, candidate.exportName);
    const occurrence = (names.get(name) ?? 0) + 1;
    names.set(name, occurrence);
    const id =
      occurrence === 1
        ? name
        : `${name}-${localCatalogDigest(`${candidate.path}\u0000${candidate.exportName}`).slice(0, 8)}`;
    return Object.freeze({
      id,
      storyId: `${id}--default`,
      path: candidate.path,
      exportName: candidate.exportName
    });
  });
}
