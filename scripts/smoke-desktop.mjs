import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const argumentsList = process.argv.slice(2);
const optionValue = (name) => {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
};

const platform = optionValue('--platform');
const directory = optionValue('--directory');
if (!platform || !directory)
  throw new Error('Usage: smoke-desktop --platform <platform> --directory <directory>');

const hostPlatform = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
if (platform !== hostPlatform) {
  console.log(
    `Skipping ${platform} launch smoke on ${hostPlatform}; cross-platform launch is not feasible.`
  );
  process.exit(0);
}

const names = { macos: 'Selene.app', linux: 'selene', windows: 'Selene.exe' };
const traversal = { visited: 0, limit: 5_000, maxDepth: 12 };
const findLaunchable = async (current, depth = 0) => {
  const entries = await readdir(current, { withFileTypes: true });
  const childDirectories = [];
  for (const entry of entries) {
    // Dirent checks make symlinked directories inert rather than following
    // them into loops or outside the package directory.
    if (entry.isSymbolicLink()) continue;
    traversal.visited += 1;
    if (traversal.visited > traversal.limit)
      throw new Error(`Desktop package traversal exceeded ${traversal.limit} entries.`);
    const path = resolve(current, entry.name);
    if (platform === 'macos' && entry.name === names.macos && entry.isDirectory())
      return resolve(path, 'Contents/MacOS/Selene');
    if (entry.isFile() && entry.name === names[platform]) return path;
    if (entry.isDirectory() && depth < traversal.maxDepth) childDirectories.push(path);
  }

  const nested = await Promise.all(
    childDirectories.map((childDirectory) => findLaunchable(childDirectory, depth + 1))
  );
  return nested.find(Boolean);
};

const executable = await findLaunchable(resolve(directory));
if (!executable) throw new Error(`No ${platform} launchable package was found in ${directory}`);

const childProcess = Bun.spawn([executable, '--smoke-test'], { stdout: 'pipe', stderr: 'pipe' });
let timedOut = false;
const exitCode = await Promise.race([
  childProcess.exited,
  new Promise((resolveTimeout) =>
    setTimeout(() => {
      timedOut = true;
      childProcess.kill();
      resolveTimeout(-1);
    }, 20_000)
  )
]);
const stdout = await new Response(childProcess.stdout).text();
const stderr = await new Response(childProcess.stderr).text();
if (timedOut || exitCode !== 0 || !stdout.includes('SELENE_DESKTOP_SMOKE_OK')) {
  throw new Error(`Desktop launch smoke failed (${exitCode}):\n${stdout}${stderr}`);
}
console.log(`Desktop launch smoke passed for ${executable}`);
