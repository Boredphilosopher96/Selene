import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stageVerifiedResource } from './verified-resource-staging.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'selene-bun-staging-'));
  roots.push(root);
  const destinationRoot = join(root, 'artifacts', 'desktop-runtime', 'bun', 'arm64');
  await mkdir(destinationRoot, { recursive: true });
  const source = join(root, 'source.zip');
  const bytes = Buffer.from('controlled verified Bun archive fixture');
  await writeFile(source, bytes, { mode: 0o600 });
  return {
    source,
    destination: join(destinationRoot, 'bun-darwin-aarch64.zip'),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

describe('verified resource staging', () => {
  it('is idempotent and leaves the same attested bytes', async () => {
    const input = await fixture();
    await stageVerifiedResource({ ...input, maximumBytes: 1024 });
    await stageVerifiedResource({ ...input, maximumBytes: 1024 });
    expect(await readFile(input.destination)).toEqual(input.bytes);
  });

  it('converges concurrent staging attempts on one attested destination', async () => {
    const input = await fixture();
    await Promise.all([
      stageVerifiedResource({ ...input, maximumBytes: 1024 }),
      stageVerifiedResource({ ...input, maximumBytes: 1024 })
    ]);
    expect(await readFile(input.destination)).toEqual(input.bytes);
  });

  it('rejects an existing staged archive with different bytes', async () => {
    const input = await fixture();
    await writeFile(input.destination, 'corrupt-existing-archive', { mode: 0o600 });
    await expect(stageVerifiedResource({ ...input, maximumBytes: 1024 })).rejects.toThrow(
      /Existing staged resource/
    );
  });
});
