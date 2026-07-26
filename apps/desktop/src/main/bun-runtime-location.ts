import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { VerifiedBunRuntimeError } from './bun-runtime-error';

export interface PinnedBunRuntimeDirectory {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

export interface BunRuntimeResourceLocation {
  readonly kind: 'development' | 'packaged';
  readonly resourceRoot: string;
  readonly directories: readonly PinnedBunRuntimeDirectory[];
}

export interface BunRuntimeResourceLocatorPort {
  locate(): Promise<BunRuntimeResourceLocation>;
  assertPinned(location: BunRuntimeResourceLocation): Promise<void>;
}

export interface DesktopBunRuntimeLocationInput {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly resourcesPath: string;
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

function failure(kind: BunRuntimeResourceLocation['kind']): VerifiedBunRuntimeError {
  return new VerifiedBunRuntimeError(
    kind === 'development' ? 'SETUP_REQUIRED' : 'TOOL_UNAVAILABLE',
    kind === 'development'
      ? 'Verified Bun development setup is required. Restart Selene and retry.'
      : 'Packaged Bun resources are unavailable or unsafe.'
  );
}

export async function pinBunRuntimeDirectory(
  path: string,
  kind: BunRuntimeResourceLocation['kind']
): Promise<PinnedBunRuntimeDirectory> {
  try {
    const before = await lstat(path);
    const actual = await realpath(path);
    const after = await lstat(path);
    const target = await lstat(actual);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      actual !== path ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      !target.isDirectory() ||
      target.isSymbolicLink() ||
      target.dev !== before.dev ||
      target.ino !== before.ino
    )
      throw failure(kind);
    return Object.freeze({ path, device: before.dev, inode: before.ino });
  } catch (error) {
    if (error instanceof VerifiedBunRuntimeError) throw error;
    throw failure(kind);
  }
}

/**
 * Host-only locator for the verified Bun data resources. Development uses a
 * deterministic repository-owned staging root; no renderer value, PATH entry,
 * shell resolution, or runtime download can influence it.
 */
export class DesktopBunRuntimeResourceLocator implements BunRuntimeResourceLocatorPort {
  public constructor(private readonly input: DesktopBunRuntimeLocationInput) {
    if (!isAbsolute(input.appPath) || !isAbsolute(input.resourcesPath))
      throw new Error('Desktop Bun runtime locations must be absolute.');
  }

  public async locate(): Promise<BunRuntimeResourceLocation> {
    const kind = this.input.isPackaged ? 'packaged' : 'development';
    if (kind === 'packaged') {
      const resources = await pinBunRuntimeDirectory(this.input.resourcesPath, kind);
      const bun = await pinBunRuntimeDirectory(resolve(resources.path, 'bun'), kind);
      const location = Object.freeze({
        kind,
        resourceRoot: resources.path,
        directories: Object.freeze([resources, bun])
      });
      await this.assertPinned(location);
      return location;
    }

    const repositoryRoot = resolve(this.input.appPath, '..', '..');
    const artifacts = resolve(repositoryRoot, 'artifacts');
    const resourceRoot = resolve(artifacts, 'desktop-runtime');
    const bunRoot = resolve(resourceRoot, 'bun');
    if (
      !contained(repositoryRoot, artifacts) ||
      !contained(repositoryRoot, resourceRoot) ||
      !contained(repositoryRoot, bunRoot)
    )
      throw failure(kind);
    const directories = Object.freeze([
      await pinBunRuntimeDirectory(repositoryRoot, kind),
      await pinBunRuntimeDirectory(artifacts, kind),
      await pinBunRuntimeDirectory(resourceRoot, kind),
      await pinBunRuntimeDirectory(bunRoot, kind)
    ]);
    const location = Object.freeze({ kind, resourceRoot, directories });
    await this.assertPinned(location);
    return location;
  }

  public async assertPinned(location: BunRuntimeResourceLocation): Promise<void> {
    for (const expected of location.directories) {
      // oxlint-disable-next-line no-await-in-loop -- Every ancestor identity is re-attested in order around resource access.
      const actual = await pinBunRuntimeDirectory(expected.path, location.kind);
      if (actual.device !== expected.device || actual.inode !== expected.inode)
        throw failure(location.kind);
    }
  }
}
