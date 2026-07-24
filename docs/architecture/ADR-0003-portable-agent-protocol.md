# ADR-0003: Provider-neutral, versioned JSONL agent protocol

- Status: accepted
- Date: 2026-07-23

## Decision

Selene agent integration is an optional, provider-neutral JSON Lines protocol.
One UTF-8 JSON object is written per line; a line is a complete envelope and
must validate against the declared schema version. `protocolVersion` is required
on every envelope, allowing a host to reject unsupported versions before acting.

The v1 envelope supports these message kinds:

| Kind      | Direction     | Purpose                                                     |
| --------- | ------------- | ----------------------------------------------------------- |
| `hello`   | either        | Declare implementation identity and capabilities.           |
| `request` | host to agent | Request an operation with typed JSON input.                 |
| `event`   | agent to host | Report progress or an optional result.                      |
| `cancel`  | either        | Ask the peer to stop a request by ID.                       |
| `error`   | either        | Report a structured failure without ambiguous text parsing. |

Capabilities are explicit strings announced in `hello`; a host must not infer
support from implementation name. A request may only use a capability negotiated
by both peers. `requestId` correlates request, event, cancel, and error messages.
Cancellation is cooperative: receipt is acknowledged with an event or error;
the host remains responsible for terminating an unresponsive child process.

Unknown optional fields are tolerated. Unknown message kinds, missing required
fields, duplicate JSON object keys, invalid UTF-8, and unsupported major schema
versions are protocol errors. Semantics that change interpretation require a new
major version. Additive optional fields may use a new minor version.

The normative v1 schema is
[`schemas/agent-protocol/v1/envelope.schema.json`](../../schemas/agent-protocol/v1/envelope.schema.json).
Fixtures illustrate valid and invalid lines without requiring a package install.

## Consequences

The protocol works for local executables, remote bridges, scripted test doubles,
and future providers. It does not prescribe a transport, authorization model, or
backend. Hosts must bound line size, validate messages before dispatch, and
enforce their own policy around any requested effect.
