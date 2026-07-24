import { app } from 'electron';

if (process.argv.includes('--smoke-test')) {
  // Keep this bootstrap deliberately dependency-free: release smoke checks
  // verify the packaged Electron executable starts and exits before normal UI
  // or preview-compiler initialization can open a window or keep it alive.
  process.stdout.write('SELENE_DESKTOP_SMOKE_OK\n', () => process.exit(0));
} else {
  void import('./desktop-runtime');
}
