const mode = process.argv[2];
let sequence = 0;

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const envelope = (kind, fields = {}) => ({
  protocolVersion: '1.0',
  kind,
  messageId: `fixture-${kind}-${++sequence}`,
  sentAt: '2026-07-23T20:30:00Z',
  ...fields
});

if (mode === 'malformed') {
  process.stdout.write('{not json}\n');
} else if (mode === 'nonzero') {
  process.nextTick(() => process.exit(12));
} else if (mode !== 'silent') {
  write(envelope('hello', { capabilities: ['simulation.run'] }));
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
    newline = buffer.indexOf('\n');
  }
});

function handle(message) {
  if (message.kind === 'request' && mode === 'stream') {
    write(
      envelope('event', {
        requestId: message.requestId,
        event: 'progress',
        output: { percent: 50 }
      })
    );
    write(
      envelope('event', {
        requestId: message.requestId,
        event: 'completed',
        output: { snapshotId: 'fixture-1' }
      })
    );
  }
  if (message.kind === 'request' && mode === 'exit-on-request') process.exit(9);
  if (message.kind === 'cancel' && mode === 'cancel') {
    write(envelope('event', { requestId: message.requestId, event: 'cancelled' }));
  }
}
