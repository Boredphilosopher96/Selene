import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Main-process-only authority for the opaque author identifier used by local
 * collaboration records. The renderer receives neither this port nor its
 * backing path, and never supplies an author ID for a mutation.
 */
export interface LocalCollaborationAuthorPort {
  authorId(): Promise<string>;
}

export interface FileLocalCollaborationAuthorOptions {
  /** Test seam around the required file-data durability barrier. */
  readonly syncTemporary?: (handle: FileHandle, path: string) => Promise<void>;
  /** Test seam around the required directory-entry durability barrier. */
  readonly syncDirectory?: (path: string) => Promise<void>;
}

const format = 'selene-local-collaboration-author/v1' as const;
const identifier = /^local-designer-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maximumIdentityBytes = 1_024;

function invalidIdentity(): Error {
  return new Error(
    'Local collaboration identity is invalid. Restore the desktop profile from backup or remove only the local collaboration identity record and restart Selene.'
  );
}

function persistenceFailure(error: unknown): Error {
  return new Error(
    `Local collaboration identity could not be saved. Free space or repair the desktop profile, then restart Selene. ${error instanceof Error ? error.message : ''}`.trim(),
    { cause: error }
  );
}

function isInvalidIdentity(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith('Local collaboration identity is invalid.')
  );
}

/** Reject display names, renderer values, and arbitrary stable identifiers at the host boundary. */
export function validateLocalCollaborationAuthorId(value: unknown): string {
  if (typeof value !== 'string' || !identifier.test(value)) throw invalidIdentity();
  return value;
}

function parseIdentity(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw invalidIdentity();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    input.format !== format ||
    typeof input.authorId !== 'string'
  )
    throw invalidIdentity();
  return validateLocalCollaborationAuthorId(input.authorId);
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ELOOP')
  );
}

function noFollow(flags: number): number {
  return typeof constants.O_NOFOLLOW === 'number' ? flags | constants.O_NOFOLLOW : flags;
}

function privateMode(mode: number): boolean {
  return (mode & 0o777) === 0o600;
}

async function readBounded(handle: FileHandle): Promise<string> {
  const bytes = Buffer.allocUnsafe(maximumIdentityBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    // oxlint-disable-next-line no-await-in-loop -- descriptor reads must advance in order.
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset === 0 || offset > maximumIdentityBytes) throw invalidIdentity();
  return bytes.subarray(0, offset).toString('utf8');
}

/**
 * Profile-private, atomically persisted identity. The value is an opaque UUID,
 * not a display name or credential; ownership of its location remains in the
 * Electron main-process composition root.
 */
export class FileLocalCollaborationAuthorPort implements LocalCollaborationAuthorPort {
  private pending: Promise<string> | undefined;

  public constructor(
    private readonly path: string,
    private readonly options: FileLocalCollaborationAuthorOptions = {}
  ) {}

  public authorId(): Promise<string> {
    this.pending ??= this.loadOrCreate();
    return this.pending;
  }

  private async loadOrCreate(): Promise<string> {
    try {
      await this.preparePrivateDirectory();
    } catch (error) {
      if (isInvalidIdentity(error)) throw error;
      throw persistenceFailure(error);
    }
    try {
      return await this.readIdentity();
    } catch (error) {
      if (isInvalidIdentity(error)) throw error;
      if (!isMissing(error)) throw persistenceFailure(error);
    }

    const authorId = `local-designer-${randomUUID()}`;
    const directory = dirname(this.path);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        temporary,
        noFollow(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL),
        0o600
      );
      await handle.writeFile(JSON.stringify({ format, authorId }), 'utf8');
      if (this.options.syncTemporary === undefined) await handle.sync();
      else await this.options.syncTemporary(handle, temporary);
      const saved = await handle.stat();
      if (!saved.isFile() || !privateMode(saved.mode)) throw invalidIdentity();
      await handle.close();
      handle = undefined;

      try {
        // A hard-link publication is an atomic create-if-absent operation. Competing ports either
        // publish one inode or observe EEXIST and load that exact winner; rename would overwrite.
        await link(temporary, this.path);
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
          throw error;
        await rm(temporary, { force: true });
        await this.syncDirectory(directory);
        return await this.readIdentity();
      }
      await rm(temporary, { force: true });
      await this.syncDirectory(directory);
      return await this.readIdentity();
    } catch (error) {
      if (isInvalidIdentity(error)) throw error;
      throw persistenceFailure(error);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async preparePrivateDirectory(): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw invalidIdentity();
    const handle = await open(directory, noFollow(constants.O_RDONLY | constants.O_DIRECTORY));
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory() || opened.dev !== entry.dev || opened.ino !== entry.ino)
        throw invalidIdentity();
      await handle.chmod(0o700);
      if ((await handle.stat()).mode & 0o077) throw invalidIdentity();
    } finally {
      await handle.close();
    }
    // Persist both the private directory inode and its parent entry before publishing identity.
    await this.syncDirectory(directory);
    await this.syncDirectory(dirname(directory));
  }

  private async readIdentity(): Promise<string> {
    const entry = await lstat(this.path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw invalidIdentity();
    const handle = await open(this.path, noFollow(constants.O_RDONLY));
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.dev !== entry.dev ||
        before.ino !== entry.ino ||
        before.nlink !== 1 ||
        before.size > maximumIdentityBytes
      )
        throw invalidIdentity();
      if (!privateMode(before.mode)) {
        await handle.chmod(0o600);
        await handle.sync();
      }
      const contents = await readBounded(handle);
      const after = await handle.stat();
      const current = await lstat(this.path);
      if (
        !privateMode(after.mode) ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        after.nlink !== 1 ||
        current.isSymbolicLink() ||
        current.dev !== after.dev ||
        current.ino !== after.ino ||
        current.nlink !== 1
      )
        throw invalidIdentity();
      return parseIdentity(JSON.parse(contents));
    } catch (error) {
      if (isMissing(error)) throw error;
      if (error instanceof SyntaxError) throw invalidIdentity();
      throw error;
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    if (this.options.syncDirectory !== undefined) {
      await this.options.syncDirectory(path);
      return;
    }
    const handle = await open(path, noFollow(constants.O_RDONLY | constants.O_DIRECTORY));
    try {
      await handle.sync();
    } catch (error) {
      const code =
        error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(String(code))) throw error;
    } finally {
      await handle.close();
    }
  }
}
