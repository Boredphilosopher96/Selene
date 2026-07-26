import { describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';

import {
  HANDOFF_ARCHIVE_FORMAT,
  archiveText,
  assertArchive,
  assertReceipt,
  consumerLock,
  createDeveloperHandoffReceipt,
  createDeveloperHandoffArchive,
  extractDeveloperHandoffArchive
} from './developer-handoff-archive.mjs';

const standalonePackageJson = {
  name: 'orders-review-r18-handoff',
  version: '0.18.0',
  dependencies: { react: '19.2.8', 'react-dom': '19.2.8' },
  devDependencies: { typescript: '7.0.2', vite: '8.1.5' }
};

function registryPackageEntries(count) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `registry-package-${index}`,
      [
        `registry-package-${index}@1.0.0`,
        '',
        {
          dependencies: { [`registry-child-${index}`]: '^1.0.0' },
          bin:
            index === 0
              ? './bin/registry-cli.js'
              : { [`registry-cli-${index}`]: './bin/registry-cli.js' }
        },
        'sha512-registry-only'
      ]
    ])
  );
}

function rootLock(packages) {
  return `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {},
  "packages": ${JSON.stringify(packages, null, 2)}
}`;
}

describe('developer handoff archive', () => {
  it('is deterministic, standalone, and receipt-bound to the exact r18 React source', async () => {
    const first = await createDeveloperHandoffArchive();
    const second = await createDeveloperHandoffArchive();

    expect(first.format).toBe(HANDOFF_ARCHIVE_FORMAT);
    expect(archiveText(first)).toBe(archiveText(second));
    expect(first.manifest.artifact.sourceRef).toMatchObject({
      provider: 'github',
      repository: expect.any(String),
      ref: expect.stringMatching(/^refs\//),
      sha: expect.stringMatching(/^[a-f0-9]{40}$/)
    });
    expect(first.manifest.commands).toEqual({
      install: 'bun install --frozen-lockfile',
      typecheck: 'bun run typecheck',
      build: 'bun run build',
      start: 'bun run start -- --host 127.0.0.1 --port 4173 --strictPort'
    });
    const files = assertArchive(first);
    expect(files.get('package.json')).not.toContain('@selene/');
    expect(files.get('package.json')).not.toContain('workspace:');
    expect(files.get('bun.lock')).not.toContain('@selene/');
    expect(files.get('src/orders-review-r18.tsx')).toContain('OrdersReviewRow');
    expect(first.manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'package.json' }),
        expect.objectContaining({ path: 'bun.lock' }),
        expect.objectContaining({ path: 'src/orders-review-r18.stories.tsx' }),
        expect.objectContaining({ path: 'src/assets/selene-crescent.svg' })
      ])
    );
    const receipt = createDeveloperHandoffReceipt(first, archiveText(first));
    expect(() => assertReceipt(receipt, archiveText(first), first)).not.toThrow();
  });

  it('rejects traversal, duplicate paths, and tampered receipts before extraction', async () => {
    const archive = await createDeveloperHandoffArchive();
    const traversal = structuredClone(archive);
    traversal.files[0].path = '../outside.tsx';
    expect(() => assertArchive(traversal)).toThrow('Unsafe handoff archive path');

    const duplicate = structuredClone(archive);
    duplicate.files[1].path = duplicate.files[0].path;
    expect(() => assertArchive(duplicate)).toThrow('Invalid or duplicate archive entry');

    const tampered = structuredClone(archive);
    tampered.files[0].content = Buffer.from('tampered').toString('base64');
    expect(() => assertArchive(tampered)).toThrow('Archive file receipt mismatch');

    const staleProvenance = structuredClone(archive);
    staleProvenance.manifest.artifact.sourceRef = 'git:not-a-sha';
    expect(() => assertArchive(staleProvenance)).toThrow('Invalid archive source ref');

    const scpCredential = structuredClone(archive);
    scpCredential.files[0].content = Buffer.from('git@host.example:private/repository').toString(
      'base64'
    );
    expect(() => assertArchive(scpCredential)).toThrow('Unsafe private, local, or secret-bearing');

    const hostileMetadata = structuredClone(archive);
    let nested = {};
    hostileMetadata.manifest.provenance = nested;
    for (let depth = 0; depth < 40; depth += 1) {
      nested.next = {};
      nested = nested.next;
    }
    expect(() => assertArchive(hostileMetadata)).toThrow('Archive metadata nesting exceeds bound');
  });

  it('scans bounded registry package records independently through the consumer lock', () => {
    expect(() =>
      consumerLock(rootLock(registryPackageEntries(257)), standalonePackageJson)
    ).not.toThrow();
    expect(() =>
      consumerLock(rootLock(registryPackageEntries(2_001)), standalonePackageJson)
    ).toThrow('bun.lock package bound exceeded');

    const oversized = registryPackageEntries(1);
    oversized['registry-package-0'][1] = 'x'.repeat(64 * 1024 + 1);
    expect(() => consumerLock(rootLock(oversized), standalonePackageJson)).toThrow(
      'Invalid or oversized bun.lock'
    );

    const deep = registryPackageEntries(1);
    let nested = [];
    for (let depth = 0; depth < 13; depth += 1) nested = [nested];
    deep['registry-package-0'][2] = nested;
    expect(() => consumerLock(rootLock(deep), standalonePackageJson)).toThrow(
      'Lock provenance nesting exceeds bound'
    );

    const privateSource = registryPackageEntries(1);
    privateSource['registry-package-0'][1] = 'git@host.example:private/repository';
    expect(() => consumerLock(rootLock(privateSource), standalonePackageJson)).toThrow(
      'Non-registry or local lock provenance'
    );

    const traversalBin = registryPackageEntries(1);
    traversalBin['registry-package-0'][2] = { bin: { 'registry-cli': '../outside.js' } };
    expect(() => consumerLock(rootLock(traversalBin), standalonePackageJson)).toThrow(
      'Unsafe bun.lock package-relative bin path'
    );

    for (const invalidPath of [
      '/bin/registry-cli.js',
      'bin\\registry-cli.js',
      'https://registry.example/bin/registry-cli.js',
      'bin/../registry-cli.js',
      'node_modules/.bin/registry-cli'
    ]) {
      const invalidBin = registryPackageEntries(1);
      invalidBin['registry-package-0'][2] = { bin: invalidPath };
      expect(() => consumerLock(rootLock(invalidBin), standalonePackageJson)).toThrow(
        'Unsafe bun.lock package-relative bin path'
      );
    }

    for (const misplacedBin of [
      { dependencies: { bin: './scripts/legitimate-looking.js' } },
      { dependencies: { bin: { registry: './scripts/legitimate-looking.js' } } }
    ]) {
      const misplaced = registryPackageEntries(1);
      misplaced['registry-package-0'][2] = misplacedBin;
      expect(() => consumerLock(rootLock(misplaced), standalonePackageJson)).toThrow(
        'Non-registry or local lock provenance'
      );
    }

    const wrongLength = registryPackageEntries(1);
    wrongLength['registry-package-0'] = ['registry-package-0@1.0.0'];
    expect(() => consumerLock(rootLock(wrongLength), standalonePackageJson)).toThrow(
      'bun.lock package record shape is invalid'
    );

    const wrongIdentity = registryPackageEntries(1);
    wrongIdentity['registry-package-0'][0] = 42;
    expect(() => consumerLock(rootLock(wrongIdentity), standalonePackageJson)).toThrow(
      'Invalid or oversized bun.lock package identity'
    );

    const wrongMetadata = registryPackageEntries(1);
    wrongMetadata['registry-package-0'][2] = [];
    expect(() => consumerLock(rootLock(wrongMetadata), standalonePackageJson)).toThrow(
      'bun.lock package metadata is invalid'
    );

    const wrongSource = registryPackageEntries(1);
    wrongSource['registry-package-0'][1] = 'registry-package-0@1.0.0';
    expect(() => consumerLock(rootLock(wrongSource), standalonePackageJson)).toThrow(
      'bun.lock package source is invalid'
    );

    const tooManyMetadataFields = registryPackageEntries(1);
    tooManyMetadataFields['registry-package-0'][2] = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`metadata-${index}`, '1.0.0'])
    );
    expect(() => consumerLock(rootLock(tooManyMetadataFields), standalonePackageJson)).toThrow(
      'Lock provenance object exceeds bound'
    );
  });

  it('rejects nested traversal or symlink entries and extracts only into a private process-owned root', async () => {
    const archive = await createDeveloperHandoffArchive();
    const nestedTraversal = structuredClone(archive);
    nestedTraversal.files[0].path = 'nested/../escape.tsx';
    expect(() => assertArchive(nestedTraversal)).toThrow('Unsafe handoff archive path');

    const symlinkEntry = structuredClone(archive);
    symlinkEntry.files[0].path = 'nested/link';
    symlinkEntry.files[0].type = 'symlink';
    expect(() => assertArchive(symlinkEntry)).toThrow('Invalid or duplicate archive entry');

    const consumer = await extractDeveloperHandoffArchive(archive);
    try {
      expect(consumer).toContain('selene-handoff-consumer-');
    } finally {
      await rm(consumer, { recursive: true, force: true });
    }
  });
});
