# Agent adapter SDK

`@selene/agent-sdk` defines the provider-neutral, dependency-free part of the
agent boundary. It contains protocol types, v1 JSONL validation, capability
negotiation, and a deterministic streaming fake. It deliberately does **not**
launch a process or read files, use Electron, or contact a network service.

The Electron main-process host at
[`apps/desktop/src/main/agent-host.ts`](../apps/desktop/src/main/agent-host.ts)
is the local-process adapter. It starts an approved executable with direct
`command` + `argv` spawning (`shell: false`), consumes one validated JSON object
per stdout line, and writes requests to stdin. The renderer never receives the
child process or its environment.

## Protocol

Every frame uses `protocolVersion: "1.0"` and has a message ID and timestamp.
The normative schema is
[`schemas/agent-protocol/v1/envelope.schema.json`](../schemas/agent-protocol/v1/envelope.schema.json).
The SDK rejects oversized lines, malformed JSON, duplicate object keys,
unsupported versions, unknown kinds, and schema-invalid required fields before
dispatching them.

| Frame     | Direction      | Meaning                                                            |
| --------- | -------------- | ------------------------------------------------------------------ |
| `hello`   | either         | Implementation identity and supported capabilities.                |
| `request` | host → adapter | A capability operation and JSON-object input.                      |
| `event`   | adapter → host | A streamed update; `completed` supplies the final optional output. |
| `cancel`  | either         | Cooperative request cancellation by request ID.                    |
| `error`   | either         | A structured, non-parseable failure.                               |

The host only dispatches a request when that capability appears in both the
explicit host grant and the adapter's `hello`. A cancellation is sent first;
the host kills a child that does not acknowledge it before the configured grace
period. A host timeout follows the same path.

## Grants and environment

An adapter configuration must name an absolute workspace root, whether it is
read-only, and each capability it authorizes. These are host policy inputs, not
authority supplied by the adapter. The host starts its child in that workspace,
but callers must still use OS sandboxing or permissions for a hard filesystem
boundary.

Only a small explicit environment allowlist is copied to the child by default:
`LANG`, `LC_ALL`, `LC_CTYPE`, `NO_COLOR`, and `TERM`. Secrets are not inherited.
Diagnostic environment views redact variable names containing `authorization`,
`credential`, `key`, `password`, `secret`, or `token`.

```ts
import { ElectronAgentHost } from './apps/desktop/src/main/agent-host';

const host = new ElectronAgentHost({
  command: '/opt/selene-adapters/local-agent',
  args: ['--stdio'],
  workspace: { root: '/absolute/path/to/project', readOnly: true },
  capabilityGrants: ['project.inspect'],
  environment: process.env
});

await host.request(
  'project.inspect',
  { projectId: 'demo' },
  {
    onEvent: (event) => console.log(event.event)
  }
);
```

For tests that do not need process behavior, use `DeterministicFakeAdapter`.
It streams a predeclared sequence without providers, timers, filesystem access,
or network access.
