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
The SDK rejects oversized lines, malformed JSON, duplicate or dangerous object
keys (`__proto__`, `constructor`, and `prototype`), unsupported versions,
unknown kinds, and schema-invalid required fields before dispatching them. Its
iterative parser applies explicit byte, nesting-depth, value-count, string-byte,
and numeric-character budgets before it materializes a frame. Every accepted
envelope, execution, event, and deterministic fake scenario is captured as a
deeply frozen data snapshot; accessor-bearing objects, custom prototypes,
symbols, cycles, and non-finite values are rejected rather than observed.

SDK consumers should use `streamValidatedEvents` when adapting arbitrary
`AgentAdapter` implementations. It revalidates unbranded executions and events
at the boundary, snapshots declared capabilities without observing accessors,
requires matching request IDs and one terminal `completed` or `cancelled`
event, and converts failures into bounded `AgentProtocolError` values. A
trusted host supplies the structural `AgentProviderRuntime` port; the SDK does
not construct pools, timers, or cancellation machinery. Every provider call
receives an `AgentProviderCallContext`, and the supplied runtime owns shared
admission, timeout conversion, caller cancellation, late-settlement quarantine, and
generation recovery. The public call options use a positive `timeoutMs` duration;
only the trusted runtime converts it to its own absolute clock. Provider callbacks
may observe a `remainingMs` duration but never that private clock value. Its
factory-issued, redacted runtime outcomes preserve cancellation
and admission classifications; lookalike errors are normalized as provider
failures. The extension bridge uses this helper by default. Hosts should
register outbound IDs with `AgentProtocolSession.beginRequest`, call
`cancelRequest` before sending cancellation, and pass inbound frames through
`acceptIncoming` so replayed, unknown, and post-terminal frames are rejected
before dispatch.

`AgentProtocolSession` accepts every schema-valid v1 identifier, including UUIDs
and application-defined IDs. It retains only a bounded set of recently completed
request IDs and inbound message IDs for the session lifetime, so it can reject
duplicates without imposing an undocumented ordering or decimal-suffix rule.
After bounded eviction, an old ID is no longer remembered: callers that need
permanent replay prevention must negotiate a future protocol capability rather
than assuming it from v1 IDs.

When a provider call is abandoned, the host quarantines that adapter generation
until its actual work settles. `replaceAdapterGeneration(adapter, runtime)` and
`recoverAdapterGeneration(adapter, runtime)` are valid only for a settled,
quarantined current generation; healthy, active, or repeatedly replaced owners
are rejected. Iterator cleanup uses one dedicated cleanup generation per adapter,
so concurrent failures cannot rotate generations or bypass its admission cap.
Replacement remains blocked until both abandoned work and any cleanup actually
settle. Trusted hosts route normal calls and cleanup through their one shared
admission pool.

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
