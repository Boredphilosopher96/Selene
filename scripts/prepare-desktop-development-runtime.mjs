import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = dirname(dirname(scriptPath));
const packagedBunPreparer = resolve(repositoryRoot, 'scripts', 'prepare-packaged-bun.mjs');

export function desktopDevelopmentRuntimePlan(platform, arch) {
  if (platform !== 'darwin')
    return Object.freeze({
      status: 'unsupported',
      message:
        'Verified local publish validation is currently macOS-only; continuing with the desktop authoring workspace.'
    });
  if (arch !== 'arm64' && arch !== 'x64')
    return Object.freeze({
      status: 'unsupported',
      message:
        'Verified local publish validation is unavailable for this macOS architecture; continuing with the desktop authoring workspace.'
    });
  return Object.freeze({
    status: 'prepare',
    executable: process.execPath,
    arguments: Object.freeze([packagedBunPreparer, '--arch', arch])
  });
}

export async function prepareDesktopDevelopmentRuntime({
  platform = process.platform,
  arch = process.arch,
  run = runPreparation
} = {}) {
  const plan = desktopDevelopmentRuntimePlan(platform, arch);
  if (plan.status === 'unsupported') {
    process.stderr.write(`[Selene] ${plan.message}\n`);
    return plan;
  }
  await run(plan.executable, plan.arguments);
  return plan;
}

async function runPreparation(executable, argumentsList) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...argumentsList], {
      cwd: repositoryRoot,
      shell: false,
      stdio: 'inherit'
    });
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolvePromise();
      else rejectPromise(new Error('Verified Bun development preparation failed.'));
    });
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath)
  await prepareDesktopDevelopmentRuntime();
