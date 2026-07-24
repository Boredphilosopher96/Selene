import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

const packageRoot = new URL('..', import.meta.url).pathname;
const bun = 'bun';
const subpaths = ['.', './postgres', './service', './history', './identity'] as const;

function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function unpackPackage(archive: string, destination: string): void {
  const tar = gunzipSync(readFileSync(archive));
  for (let offset = 0; offset + 512 <= tar.byteLength;) {
    const header = tar.subarray(offset, offset + 512);
    const name = text(header.subarray(0, 100));
    if (!name) break;
    const size = Number.parseInt(text(header.subarray(124, 136)).trim(), 8) || 0;
    const type = text(header.subarray(156, 157));
    const relative = name.startsWith('package/') ? name.slice('package/'.length) : '';
    const target = relative && !relative.includes('..') ? join(destination, relative) : undefined;
    if (target && type !== '5') {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, tar.subarray(offset + 512, offset + 512 + size));
    } else if (target) {
      mkdirSync(target, { recursive: true });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

function packageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? packageFiles(join(directory, entry.name)) : [join(directory, entry.name)]
  );
}

describe('published collaboration package boundary', () => {
  it('loads every declared subpath and strict typechecks without host-runtime', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'selene-collaboration-consumer-'));
    try {
      execFileSync(bun, ['run', 'build'], { cwd: packageRoot, stdio: 'pipe' });
      execFileSync(bun, ['pm', 'pack', '--destination', workspace], {
        cwd: packageRoot,
        stdio: 'pipe'
      });
      const archive = readdirSync(workspace).find((name) => name.endsWith('.tgz'));
      expect(archive).toBeDefined();
      const consumer = join(workspace, 'consumer');
      mkdirSync(consumer);
      writeFileSync(join(consumer, 'package.json'), '{"name":"consumer","type":"module"}\n');
      const installed = join(consumer, 'node_modules', '@selene', 'collaboration');
      unpackPackage(join(workspace, archive!), installed);
      for (const file of packageFiles(installed).filter((sourceFile) =>
        /(?:\.d\.ts|\.js)$/.test(sourceFile)
      ))
        expect(readFileSync(file, 'utf8')).not.toContain('@selene/host-runtime');
      const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
        exports: Record<string, { readonly import?: string; readonly types?: string }>;
      };
      for (const subpath of subpaths) {
        const target = manifest.exports[subpath];
        expect(target?.import).toBeDefined();
        expect(target?.types).toBeDefined();
        expect(readFileSync(join(installed, target.import!), 'utf8')).not.toContain(
          '@selene/host-runtime'
        );
        expect(readFileSync(join(installed, target.types!), 'utf8')).not.toContain(
          '@selene/host-runtime'
        );
      }
      const loaded = execFileSync(
        bun,
        [
          '--eval',
          `Promise.all(${JSON.stringify(subpaths)}.map((path) => import('@selene/collaboration' + (path === '.' ? '' : path.slice(1))))).then(() => process.stdout.write('loaded'))`
        ],
        { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      expect(loaded).toBe('loaded');
      writeFileSync(
        join(consumer, 'consumer.ts'),
        `import * as root from '@selene/collaboration';
import * as postgres from '@selene/collaboration/postgres';
import * as service from '@selene/collaboration/service';
import * as history from '@selene/collaboration/history';
import * as identity from '@selene/collaboration/identity';
declare const context: root.CollaborationHostContext;
const options = {} as service.ServiceOptions;
void [context, options, postgres, history, identity];
`
      );
      writeFileSync(
        join(consumer, 'tsconfig.json'),
        '{"compilerOptions":{"strict":true,"noEmit":true,"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022"}}\n'
      );
      execFileSync(
        process.execPath,
        [join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
        { cwd: consumer, stdio: 'pipe' }
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
