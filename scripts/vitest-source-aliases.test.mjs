import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { missingAliasEntries, sourceSpecifiers } from './vitest-source-aliases.mjs';

describe('Vitest workspace source alias checking', () => {
  it('checks static, side-effect, re-export, dynamic, and type-only imports', () => {
    expect(
      sourceSpecifiers(`
        import {\n value\n } from '@selene/fixture/multiline';
        import '@selene/fixture/side-effect';
        export { value } from '@selene/fixture/re-export';
        export * from '@selene/fixture/export-star';
        export * as namespace from '@selene/fixture/namespace';
        void import('@selene/fixture/dynamic', { with: { type: 'json' } });
        void import(\`@selene/fixture/static-template\`);
        type Imported = import('@selene/fixture/type').Value;
        import Required = require('@selene/fixture/require');
        import escaped from '@selene/fixture/esc\\u0061ped';
      `)
    ).toEqual([
      '@selene/fixture/multiline',
      '@selene/fixture/side-effect',
      '@selene/fixture/re-export',
      '@selene/fixture/export-star',
      '@selene/fixture/namespace',
      '@selene/fixture/dynamic',
      '@selene/fixture/static-template',
      '@selene/fixture/type',
      '@selene/fixture/require',
      '@selene/fixture/escaped'
    ]);
  });

  it('excludes comments, strings, template text, regexes, and nonliteral calls', () => {
    expect(
      sourceSpecifiers(
        [
          "// import '@selene/fixture/comment';",
          "/* export * from '@selene/fixture/block-comment'; */",
          'const text = "import \'@selene/fixture/string\'";',
          "const template = `import('@selene/fixture/template')`;",
          "const interpolated = `before ${1} import('@selene/fixture/template-tail')`;",
          "const pattern = /import\\('@selene\\/fixture\\/regex'\\)/;",
          "if (true) /import('@selene\\/fixture\\/conditional-regex')/.test(text);",
          "const object = { import: () => '@selene/fixture/property' };",
          "object.import('@selene/fixture/method');",
          'void import(getSpecifier());',
          "void import('@selene/fixture/' + name);",
          'void import(`@selene/fixture/${name}`);'
        ].join('\n')
      )
    ).toEqual([]);
  });

  it('handles nested template contexts and checks actual code inside interpolations', () => {
    // These nested templates followed by markdown match designer-service.test.ts.
    const source = [
      "const content = `export default function App(){return <h1 ${inlineStyle.length === 0 ? '' : ` style={{ ${inlineStyle} }}`}>${content}</h1>;}`;",
      "const markdown = `# Guidance\\n\\n${'Use semantic tokens.\\n'.repeat(4_096)}`;",
      "const nested = `text ${`inner ${({ value: /}/ }).value} ${import('@selene/fixture/interpolation')}`} export * from '@selene/fixture/tail'`;",
      'const ratio = numerator / denominator;',
      "void import('@selene/fixture/after-templates');"
    ].join('\n');
    expect(sourceSpecifiers(source)).toEqual([
      '@selene/fixture/interpolation',
      '@selene/fixture/after-templates'
    ]);
  });

  it('parses TSX by its filename and excludes JSX text and attributes', () => {
    expect(
      sourceSpecifiers(
        `const view = <div title="import('@selene/fixture/attribute')">
          import('@selene/fixture/jsx-text')
          {import('@selene/fixture/jsx-expression')}
        </div>;`,
        'fixture.test.tsx'
      )
    ).toEqual(['@selene/fixture/jsx-expression']);
  });

  it('fails closed when a source cannot be parsed', () => {
    expect(() =>
      sourceSpecifiers("import '@selene/fixture/unterminated", 'broken.test.ts')
    ).toThrow(/Cannot check Vitest source aliases in broken\.test\.ts:1:/);
  });

  it('requires explicit subpath aliases and ignores packages outside this workspace', () => {
    const imports = new Map([
      ['@selene/fixture', 'root.test.ts'],
      ['@selene/fixture/subpath', 'subpath.test.ts'],
      ['@selene/fixture/covered', 'covered.test.ts'],
      ['@selene/external', 'external.test.ts']
    ]);
    expect(
      missingAliasEntries(
        imports,
        new Set(['@selene/fixture', '@selene/fixture/covered']),
        new Set(['@selene/fixture'])
      )
    ).toEqual(['@selene/fixture/subpath (subpath.test.ts)']);
    expect(missingAliasEntries(imports, new Set(), new Set(['@selene/fixture']))).toEqual([
      '@selene/fixture (root.test.ts)',
      '@selene/fixture/subpath (subpath.test.ts)',
      '@selene/fixture/covered (covered.test.ts)'
    ]);
  });

  it('terminates on the complete designer-service source within a bounded child process', () => {
    // A timeout and a small heap contain regressions to the old endless scanner
    // loop without exhausting the test worker or the machine running CI.
    const result = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=128',
        '--input-type=module',
        '--eval',
        `import { readFileSync } from 'node:fs';
         import { sourceSpecifiers } from './scripts/vitest-source-aliases.mjs';
         const source = readFileSync('apps/desktop/src/main/designer-service.test.ts', 'utf8');
         console.log(JSON.stringify(sourceSpecifiers(
           source + "\\nvoid import('@selene/fixture/after-real-source');",
           'designer-service.test.ts'
         )));`
      ],
      {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        timeout: 10_000,
        maxBuffer: 16 * 1024,
        encoding: 'utf8'
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      '@selene/core',
      '@selene/design-inputs',
      '@selene/collaboration',
      '@selene/fixture/after-real-source'
    ]);
  }, 15_000);
});
