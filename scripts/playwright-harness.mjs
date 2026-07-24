import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

const hostedPorts = Object.freeze({
  browser: 4173,
  accessibilityWeb: 4174,
  accessibilityStorybook: 6009,
  startup: 4176,
  visualStorybook: 6008,
  storybook: 6006
});

const portOffsets = Object.freeze({
  browser: 0,
  accessibilityWeb: 1,
  accessibilityStorybook: 2,
  startup: 3,
  visualStorybook: 4,
  storybook: 5
});

const localPortFloor = 46_000;
const localPortSpan = 1_800;
const portsPerWorktree = 10;

function configuredPortBase(environment) {
  const value = environment.SELENE_HARNESS_PORT_BASE;
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value))
    throw new Error('SELENE_HARNESS_PORT_BASE must be an integer TCP port.');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_530)
    throw new Error('SELENE_HARNESS_PORT_BASE must be between 1024 and 65530.');
  return port;
}

/** Stable, filesystem-safe identifier used in logs and isolated Electron user-data paths. */
export function harnessIdentity(worktree = process.cwd()) {
  return createHash('sha256').update(worktree).digest('hex').slice(0, 10);
}

/**
 * Hosted CI keeps its historical fixed ports. Local runs derive a non-overlapping
 * port block from the absolute worktree path, unless explicitly overridden.
 */
export function harnessPorts(environment = process.env, worktree = process.cwd()) {
  if (environment.CI) return hostedPorts;
  const configured = configuredPortBase(environment);
  const derived =
    localPortFloor +
    ((Number.parseInt(harnessIdentity(worktree).slice(0, 6), 16) % localPortSpan) /
      portsPerWorktree) *
      portsPerWorktree;
  const base = configured ?? Math.floor(derived);
  const ports = Object.fromEntries(
    Object.entries(portOffsets).map(([name, offset]) => [name, base + offset])
  );
  if (Math.max(...Object.values(ports)) > 65_535)
    throw new Error('SELENE_HARNESS_PORT_BASE leaves no room for every Playwright harness.');
  return ports;
}

export function harnessUrl(port) {
  return `http://127.0.0.1:${port}`;
}

/** Refuses an occupied port before a Playwright server command can attach to another worktree. */
export async function assertHarnessPortAvailable(label, port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error && typeof error === 'object' && error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Refusing to start ${label}: 127.0.0.1:${port} is already occupied by an unrelated service. ` +
              'Choose SELENE_HARNESS_PORT_BASE or use a separate worktree.'
          )
        );
      } else reject(error);
    });
    server.listen({ host: '127.0.0.1', port }, resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}
