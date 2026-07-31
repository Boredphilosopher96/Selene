# Design-system packages

Selene treats a design system as a versioned npm package with explicit,
data-only metadata. The package remains the source of truth for React
implementations; Selene reads the approved export map and catalog metadata,
then preserves package, version, export, and artifact-digest provenance through
preview editing and developer handoff.

## Package metadata

Add a `selene.designSystem` object to `package.json`:

```json
{
  "name": "@acme/design-system",
  "version": "3.2.0",
  "peerDependencies": {
    "react": "^19.0.0"
  },
  "exports": {
    ".": "./dist/index.js"
  },
  "selene": {
    "designSystem": {
      "schemaVersion": "1",
      "tokenFiles": ["./dist/tokens.json"],
      "components": [
        {
          "name": "Button",
          "entrypoint": ".",
          "exportName": "Button",
          "properties": [
            {
              "name": "tone",
              "label": "Tone",
              "control": "select",
              "values": ["primary", "secondary"],
              "defaultValue": "primary"
            },
            {
              "name": "label",
              "label": "Label",
              "control": "text",
              "required": true,
              "defaultValue": "Continue"
            }
          ]
        }
      ],
      "patterns": [
        {
          "id": "primary-action",
          "label": "Primary action",
          "description": "The standard action for completing a task.",
          "component": {
            "entrypoint": ".",
            "exportName": "Button"
          }
        }
      ],
      "templates": [
        {
          "id": "checkout-action-section",
          "label": "Checkout action section",
          "description": "A ready-to-customize primary checkout action.",
          "kind": "section",
          "component": {
            "entrypoint": ".",
            "exportName": "Button"
          },
          "propertyValues": {
            "label": "Continue to checkout",
            "tone": "primary"
          }
        }
      ],
      "designLanguagePath": "./DESIGN.md"
    }
  }
}
```

Components identify real published React exports. Their optional properties
describe bounded boolean, number, text, or select controls. Patterns are curated
catalog aliases for one declared component export; they inherit that
component's properties and insertion policy. Templates declare a complete
screen or reusable section through one approved React export and may provide
validated initial property values. Designers can change those values before
insertion.

Patterns and templates do not contain JSX, arbitrary imports, slots, scripts,
or remote runtime references. Both therefore use the same host-authorized React
insertion path as their component. The renderer cannot invent a package,
revision, target node, export, artifact digest, or undeclared property.

## Validation limits

- Pattern IDs use lowercase letters, numbers, and hyphens, begin with a letter,
  and are at most 64 characters.
- Labels are trimmed and at most 80 bytes; descriptions are trimmed and at
  most 512 bytes.
- A package may declare at most 64 patterns.
- Pattern IDs must be unique within the package.
- Every pattern must reference exactly one entrypoint/export pair already
  declared in `components`.
- Template IDs follow the same identifier and uniqueness constraints. A package
  may declare at most 64 templates, each with `kind: "screen"` or
  `kind: "section"`.
- Template property values must name declared component properties and satisfy
  their exact boolean, number, text, or select control.
- Every component entrypoint must also exist in the package `exports` map.

Invalid or accessor-backed metadata is rejected before it reaches the Desktop
catalog. Staging package metadata does not install or activate package code.

## Desktop behavior

The **Components** workspace is a dedicated, searchable inventory beside
Design and Present. It is deliberately separate from the product prototype:
the prototype exercises connected screens and simulated navigation, while the
component workspace reviews reusable exports, package ownership, integrity,
declared props, patterns, and templates. **Use in design** returns to the
canvas with the corresponding Assets result selected.

Story previews fail closed. Until the main process supplies a validated,
revision-bound Storybook preview capability for an entry, the component
workspace shows an explicit unavailable state. It never guesses a Storybook
URL from a source path and never imports or executes npm package code in the
renderer.

For canonical local-project exports, Desktop now supplies that capability
through `LocalStoryPreviewRuntime`. The main process derives one deterministic
default story per unique React export from the exact current workspace, keeps a
bounded revision-keyed catalog, compiles the isolated story with the same
governed Vite compiler as the product preview, and publishes only the resulting
artifact through the no-network `selene-preview://` sandbox. Workspace changes
replace the catalog/build identity, so previously issued story capabilities
cannot render stale source. Package-provided stories remain unavailable unless
their trusted host adapter can prove and compile the declared package revision;
the renderer never imports them directly.

The generated Bun repository uses the same stable component/story identity for
its real CSF files and writes a validated `selene-component-catalog/v1` directly
to `selene/component-catalog.json`. Its Storybook output directory and build
identity are therefore portable handoff metadata, not a lossy copy of the
Desktop Assets projection.

The portable `selene-component-catalog/v1` manifest is parsed in the trusted
host and projected through `selene-component-catalog-projection/v1`. That
projection retains only canonical project, catalog revision, build,
component-owner, prop, required-coverage, and story identity. Storybook URLs,
output directories, CSF file paths, component source paths, token sources, and
documentation URLs remain host-owned. A missing, invalid, cross-project, or
stale manifest becomes one bounded unavailable reason; raw parser or filesystem
details are never sent to the renderer.

When a trusted host can compile a canonical story, it may issue a
`selene-story-preview-ticket/v1`. The ticket is an unguessable, bounded
capability fenced to the exact project, source revision, catalog revision,
Storybook build, component, and story. Every use revalidates the current
manifest before and after compilation; token or identity tampering, source or
catalog drift, revocation, unsupported builders, and superseded callers fail
closed. Only the sandboxed `selene-preview://` publication is returned. The
ticket and result contain no Storybook URL, CSF file, component source path, or
compiler input.

Approved components, patterns, and templates appear together in the Desktop
Assets panel. Patterns and screen/section templates have distinct badges and
searchable descriptions. Template presets initialize the same editable variant
controls used by their component. Designers select a mapped flex or grid React
container, then insert by button or catalog drag. Assets marks the target ready
only when the main process has reparsed the current TSX and confirmed that the
selected node has an authored inline `display: "flex"` or `display: "grid"`;
computed iframe CSS is never treated as source authority. Incompatible mapped
selections remain selected for inspection but receive an actionable container
message. The main process revalidates the component identity, artifact digest,
current source revision, selected node, and final property values again before
proposing a source edit.

For an existing mapped React element, **Replace** swaps only the opening and
closing component type plus declared catalog properties. The exact stable node
marker and existing React children are preserved, so review threads and
selection identity survive the change. The replacement is compiler-validated
before persistence; incompatible children, import conflicts, stale revisions,
and unapproved exports fail without mutating source.
