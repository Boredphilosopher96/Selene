import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

async function pinDirectory(path) {
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
    throw new Error('Verified resource staging directory is unsafe.');
  return Object.freeze({ path, device: before.dev, inode: before.ino });
}

async function assertPinned(expected) {
  const actual = await pinDirectory(expected.path);
  if (actual.device !== expected.device || actual.inode !== expected.inode)
    throw new Error('Verified resource staging directory changed.');
}

async function hashNoFollow(path, maximumBytes) {
  if (typeof constants.O_NOFOLLOW !== 'number')
    throw new Error('This platform cannot safely verify a staged resource.');
  const pathBefore = await lstat(path);
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.size <= 0 ||
    pathBefore.size > maximumBytes
  )
    throw new Error('Verified staged resource is unsafe.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== pathBefore.size)
      throw new Error('Verified staged resource changed while being read.');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < before.size; position += buffer.byteLength) {
      // oxlint-disable-next-line no-await-in-loop -- Ordered descriptor reads attest one immutable resource.
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - position),
        position
      );
      if (result.bytesRead === 0)
        throw new Error('Verified staged resource changed while being read.');
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (after.size !== before.size || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino)
      throw new Error('Verified staged resource changed while being read.');
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function copyNoFollowExclusive(source, destination, maximumBytes) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes)
      throw new Error('Verified resource staging source is unsafe.');
    output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < before.size; position += buffer.byteLength) {
      // oxlint-disable-next-line no-await-in-loop -- Ordered descriptor reads preserve the attested source identity.
      const result = await input.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - position),
        position
      );
      if (result.bytesRead === 0)
        throw new Error('Verified resource staging source changed while being read.');
      let offset = 0;
      while (offset < result.bytesRead) {
        // oxlint-disable-next-line no-await-in-loop -- Partial descriptor writes advance the same exclusive file.
        const written = await output.write(buffer, offset, result.bytesRead - offset, null);
        if (written.bytesWritten <= 0)
          throw new Error('Verified resource staging write did not make progress.');
        offset += written.bytesWritten;
      }
    }
    await output.sync();
    const after = await input.stat();
    const sourceAfter = await lstat(source);
    if (
      after.size !== before.size ||
      sourceAfter.dev !== before.dev ||
      sourceAfter.ino !== before.ino
    )
      throw new Error('Verified resource staging source changed while being read.');
  } finally {
    await output?.close().catch(() => undefined);
    await input.close();
  }
}

/** Idempotent, concurrency-safe installation of one already-attested data resource. */
export async function stageVerifiedResource({ source, destination, sha256, maximumBytes }) {
  if (!/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error('Verified resource staging policy is invalid.');
  const parent = await pinDirectory(dirname(destination));
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyNoFollowExclusive(source, temporary, maximumBytes);
    if ((await hashNoFollow(temporary, maximumBytes)) !== sha256)
      throw new Error('Verified resource staging source does not match fixed provenance.');
    await assertPinned(parent);
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    await assertPinned(parent);
    if ((await hashNoFollow(destination, maximumBytes)) !== sha256)
      throw new Error('Existing staged resource does not match fixed provenance.');
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
