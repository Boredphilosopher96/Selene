# Project federation and static handoff

Selene federation is a data contract for coordinating independently owned projects. It
does not use runtime module federation, remote entries, dynamic imports, or an agent
SDK. A host validates manifests, aggregates a catalog in a deterministic order, and
can write the resulting handoff JSON to any host-controlled static download location.

Each project manifest is validated by the portable schema at
`schemas/project-federation/v1/manifest.schema.json`. Every manifest declares:

- immutable project identity, shell or child role, parent relationship, ownership,
  status, and changelog;
- design-system package and token references, screens, routes, and Storybook URLs;
- React-source pointers and independently deployable static-site metadata.

`@selene/core` exposes `validateFederation` for deterministic compatibility diagnostics
and `aggregateFederation` for a stable catalog. Validation rejects duplicate children,
parent or shell-child mismatches, overlapping node ownership, duplicate routes, and
incompatible design-system references. It never resolves, fetches, or executes a
remote module.

`createHandoffBundle` turns a valid catalog into JSON-ready data containing the complete
machine-readable manifest, React-source pointers, comments, developer directions, a
checksummed download descriptor, and machine-readable agent-download metadata.
`serializeHandoffBundle` produces deterministic, newline-terminated JSON for static
hosting. Checksums and URLs are supplied by the host; the core does not host artifacts
or handle credentials.

## Executable prototypes and component catalogs

An executable product simulation and Storybook catalog are different generated
artifacts. `ExecutablePrototypeManifest` (`selene-executable-prototype/v1`)
declares real React screens/routes, action-graph ports, deterministic local
fixtures, and product states. Its runtime contract explicitly forbids network
and backend integration. `ComponentCatalogManifest`
(`selene-component-catalog/v1`) instead declares owned component source,
typed props, real CSF files, state/accessibility coverage, and Storybook build
metadata. It deliberately has no route field.

`validateArtifactManifests` checks project/design-system compatibility,
prototype-to-story traceability, action-port links, and catalog freshness.
`validateComponentCatalogSources` accepts a host-owned source reader and checks
that declared source exports and CSF exports exist; it does not grant any
filesystem authority itself. `aggregateComponentCatalogs` builds a shell index
from child catalog manifests only—no component source is copied or executed.
`createArtifactHandoffBundle` emits both manifests under distinct fields and
preserves each artifact's provenance.

The [`examples/generated/orders-prototype`](../examples/generated/orders-prototype)
slice uses the same real `OrdersPage` React component in the local product
simulation and curated CSF stories. `bun run check:artifact-manifests` is part
of `bun run build`, so CI detects stale, missing, or broken catalog references
before it builds Storybook separately.

The [`examples/federation`](../examples/federation) directory demonstrates one
Commerce shell with independently static Orders and Customer Service child projects.
Their separate `baseUrl` and `outputDirectory` values are deployment metadata, not
runtime composition instructions. The shell handoff bundle records only portable JSON
references that a host or human can verify before download.
