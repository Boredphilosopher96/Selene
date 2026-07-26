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

function compactRegistryPackageEntries(count) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `p${index}`,
      [`p${index}@1.0.0`, '', {}, 'sha512-registry-only']
    ])
  );
}

function rootLock(packages, policy = {}) {
  return `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {},
  ${policy.patchedDependencies === undefined ? '' : `"patchedDependencies": ${JSON.stringify(policy.patchedDependencies)},`}
  ${policy.overrides === undefined ? '' : `"overrides": ${JSON.stringify(policy.overrides)},`}
  "packages": ${JSON.stringify(packages, null, 2)}
}`;
}

function standaloneLock(packages) {
  return `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": ${JSON.stringify(
      {
        name: standalonePackageJson.name,
        dependencies: standalonePackageJson.dependencies,
        devDependencies: standalonePackageJson.devDependencies
      },
      null,
      2
    )}
  },
  "packages": ${JSON.stringify(packages, null, 2)}
}`;
}

function validateConsumerLock(packages, rootPackages = packages) {
  return consumerLock(standaloneLock(packages), rootLock(rootPackages), standalonePackageJson);
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
    expect(files.get('bun.lock')).toContain('"patchedDependencies"');
    expect(files.get('patches/brace-expansion@5.0.8.patch')).toContain(
      'module.exports = callableExpand'
    );
    expect(files.get('src/orders-review-r18.tsx')).toContain('OrdersReviewRow');
    expect(first.files.find((entry) => entry.path === 'bun.lock')?.content.length).toBeGreaterThan(
      64 * 1024
    );
    expect(first.manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'package.json' }),
        expect.objectContaining({ path: 'bun.lock' }),
        expect.objectContaining({ path: 'patches/brace-expansion@5.0.8.patch' }),
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

    const oversizedMetadata = structuredClone(archive);
    oversizedMetadata.manifest.provenance.designDirection[0] = 'x'.repeat(64 * 1024 + 1);
    expect(() => assertArchive(oversizedMetadata)).toThrow('Invalid or oversized archive string');

    const oversizedEntry = structuredClone(archive);
    oversizedEntry.files[0].content = Buffer.alloc(512 * 1024 + 1, 'x').toString('base64');
    expect(() => assertArchive(oversizedEntry)).toThrow('Archive entry exceeds byte bound');

    const oversizedArchive = structuredClone(archive);
    oversizedArchive.files = Array.from({ length: 33 }, (_, index) => ({
      ...oversizedArchive.files[0],
      path: `oversized-${index}.tsx`
    }));
    expect(() => archiveText(oversizedArchive)).toThrow('Archive entry bound exceeded');
  });

  it('scans bounded registry package records independently through the consumer lock', () => {
    expect(() => validateConsumerLock(registryPackageEntries(257))).not.toThrow();
    expect(() => validateConsumerLock(compactRegistryPackageEntries(2_001))).toThrow(
      'bun.lock package bound exceeded'
    );

    const oversized = registryPackageEntries(1);
    oversized['registry-package-0'][1] = 'x'.repeat(64 * 1024 + 1);
    expect(() => validateConsumerLock(oversized)).toThrow('Invalid or oversized bun.lock');

    const deep = registryPackageEntries(1);
    let nested = {};
    for (let depth = 0; depth < 13; depth += 1) nested = { next: nested };
    deep['registry-package-0'][2] = { dependencyGraph: nested };
    expect(() => validateConsumerLock(deep)).toThrow('Lock provenance nesting exceeds bound');

    const privateSource = registryPackageEntries(1);
    privateSource['registry-package-0'][1] = 'git@host.example:private/repository';
    expect(() => validateConsumerLock(privateSource)).toThrow(
      'Non-registry or local lock provenance'
    );

    const traversalBin = registryPackageEntries(1);
    traversalBin['registry-package-0'][2] = { bin: { 'registry-cli': '../outside.js' } };
    expect(() => validateConsumerLock(traversalBin)).toThrow(
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
      expect(() => validateConsumerLock(invalidBin)).toThrow(
        'Unsafe bun.lock package-relative bin path'
      );
    }

    for (const misplacedBin of [
      { dependencies: { bin: './scripts/legitimate-looking.js' } },
      { dependencies: { bin: { registry: './scripts/legitimate-looking.js' } } }
    ]) {
      const misplaced = registryPackageEntries(1);
      misplaced['registry-package-0'][2] = misplacedBin;
      expect(() => validateConsumerLock(misplaced)).toThrow(
        'Non-registry or local lock provenance'
      );
    }

    const wrongLength = registryPackageEntries(1);
    wrongLength['registry-package-0'] = ['registry-package-0@1.0.0'];
    expect(() => validateConsumerLock(wrongLength)).toThrow(
      'bun.lock package record shape is invalid'
    );

    const wrongIdentity = registryPackageEntries(1);
    wrongIdentity['registry-package-0'][0] = 42;
    expect(() => validateConsumerLock(wrongIdentity)).toThrow(
      'Invalid or oversized bun.lock package identity'
    );

    const wrongMetadata = registryPackageEntries(1);
    wrongMetadata['registry-package-0'][2] = [];
    expect(() => validateConsumerLock(wrongMetadata)).toThrow(
      'bun.lock package metadata is invalid'
    );

    const wrongSource = registryPackageEntries(1);
    wrongSource['registry-package-0'][1] = 'registry-package-0@1.0.0';
    expect(() => validateConsumerLock(wrongSource)).toThrow('bun.lock package source is invalid');

    const tooManyMetadataFields = registryPackageEntries(1);
    tooManyMetadataFields['registry-package-0'][2] = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`metadata-${index}`, '1.0.0'])
    );
    expect(() => validateConsumerLock(tooManyMetadataFields)).toThrow(
      'Lock provenance object exceeds bound'
    );
  });

  it('rejects standalone package records that diverge from the root supply-chain lock', () => {
    const standalonePackages = registryPackageEntries(2);
    const changedRootPackages = structuredClone(standalonePackages);
    changedRootPackages['registry-package-1'][3] = 'sha512-different-integrity';
    expect(() => validateConsumerLock(standalonePackages, changedRootPackages)).toThrow(
      'Standalone bun.lock package diverges from root lock: registry-package-1'
    );

    const swappedLocator = {
      'spoofed-package': standalonePackages['registry-package-0']
    };
    expect(() => validateConsumerLock(swappedLocator, standalonePackages)).toThrow(
      'Standalone bun.lock locator does not match package identity: spoofed-package'
    );
  });

  it('rejects omitted root patch policy for a package in the standalone closure', () => {
    const packages = registryPackageEntries(1);
    expect(() =>
      consumerLock(
        standaloneLock(packages),
        rootLock(packages, {
          patchedDependencies: {
            'registry-package-0@1.0.0': 'patches/registry-package-0@1.0.0.patch'
          }
        }),
        standalonePackageJson
      )
    ).toThrow('Standalone bun.lock omits root patch policy: registry-package-0@1.0.0');
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
