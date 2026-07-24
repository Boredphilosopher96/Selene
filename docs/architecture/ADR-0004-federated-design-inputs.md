# ADR-0004: Federated design inputs and downloadable handoff

- Status: accepted
- Date: 2026-07-23

## Decision

Selene accepts two portable design inputs:

1. An npm design-library manifest: a package identifier, version, entrypoints,
   token references, and component metadata supplied by the host.
2. A Markdown design-language document: human-readable principles, constraints,
   examples, and links.

Neither input is implicitly executed. The host resolves package artifacts using
its own lockfile and policy; Markdown is parsed as data and rendered safely.

Projects federate work through a shell manifest plus zero or more child manifests.
Each manifest declares an immutable `projectId`, its parent relationship,
owned node-ID prefixes or explicit node lists, and a status record. Ownership is
single-writer: a child cannot claim a node already owned by another child unless
the shell explicitly transfers it. The shell aggregates status, changelog
entries, and Storybook references from children without rewriting their history.

A handoff is a downloadable archive or link descriptor produced by a host. It
includes a snapshot reference, schema versions, checksums, and optional expiry;
it contains no credentials. A receiver verifies checksums and obtains the bytes
through the named host-controlled link. Handoff creation does not imply public
hosting or backend storage.

## Consequences

- Teams can compose independently versioned libraries and child projects.
- Storybook remains an optional external reference, not a mandatory runtime.
- The portable manifest schema provides a common import/export shape while hosts
  retain package installation, link hosting, and access-control decisions.
