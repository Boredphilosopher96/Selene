import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ElectronAgentHost } from './agent-host';

const adapter = fileURLToPath(
  new URL('../../../../examples/adapters/codex-jsonl.mjs', import.meta.url)
);

it('bridges a CLI patch and cancels its process before returning the terminal acknowledgement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selene-cli-example-proof-'));
  const fake = join(root, 'cli.mjs');
  const receipt = join(root, 'process.json');
  await writeFile(
    fake,
    `import {writeFileSync} from 'node:fs';
const mode=process.argv[2];const receipt=process.argv[3];
writeFileSync(receipt,JSON.stringify({pid:process.pid,cwd:process.cwd()}));
let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);
process.stdin.on('end',()=>{if(mode==='cancel'){setInterval(()=>{},1000);return;}
const input=JSON.parse(prompt.split('\\n').at(-1));
const output={summary:'CLI changed the heading',operations:[{type:'write',path:'src/App.tsx',content:input.workspace.files[0].content.replace('Orders','CLI Orders')}]};
writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify(output));});`
  );
  const host = (mode: string) =>
    new ElectronAgentHost({
      command: process.execPath,
      args: [adapter, process.execPath, fake, mode, receipt],
      workspace: { root, readOnly: true },
      capabilityGrants: ['react.revise']
    });
  const input = {
    instruction: 'Rename the heading',
    workspace: {
      format: 'selene-react-workspace/v1',
      files: [
        { path: 'src/App.tsx', content: 'export default function App(){return <h1>Orders</h1>}' }
      ]
    }
  };
  const success = host('success');
  let cancelled: ReturnType<typeof host> | undefined;
  try {
    await expect(success.request('react.revise', input, { timeoutMs: 5000 })).resolves.toEqual({
      summary: 'CLI changed the heading',
      operations: [
        {
          type: 'write',
          path: 'src/App.tsx',
          content: 'export default function App(){return <h1>CLI Orders</h1>}'
        }
      ]
    });
    const finished = JSON.parse(await readFile(receipt, 'utf8')) as { pid: number; cwd: string };
    await expect(readFile(join(finished.cwd, 'patch.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });
    cancelled = host('cancel');
    const controller = new AbortController();
    const result = cancelled.request('react.revise', input, {
      signal: controller.signal,
      timeoutMs: 5000
    });
    const rejected = expect(result).rejects.toThrow();
    await expect
      .poll(async () => {
        try {
          return (
            (JSON.parse(await readFile(receipt, 'utf8')) as { pid: number }).pid !== finished.pid
          );
        } catch {
          return false;
        }
      })
      .toBe(true);
    controller.abort();
    await rejected;
    const stopped = JSON.parse(await readFile(receipt, 'utf8')) as { pid: number; cwd: string };
    expect(stopped.pid).not.toBe(finished.pid);
    await expect
      .poll(() => {
        try {
          process.kill(stopped.pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    await expect
      .poll(async () => {
        try {
          await readFile(join(stopped.cwd, 'patch-schema.json'));
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    success.stop();
    cancelled?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
