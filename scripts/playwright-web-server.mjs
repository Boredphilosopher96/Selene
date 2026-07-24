import { runHarnessServer } from './harness-server-process.mjs';

const [label, portText, command, ...arguments_] = process.argv.slice(2);
const port = Number(portText);
if (!label || !Number.isSafeInteger(port) || !command) {
  throw new Error('Usage: playwright-web-server.mjs <label> <port> <command> [args...]');
}

process.exitCode = await runHarnessServer({ label, port, command, arguments_ });
