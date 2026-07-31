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
        },
        {
          "name": "Stack",
          "entrypoint": ".",
          "exportName": "Stack",
          "slots": [
            {
              "id": "content",
              "label": "Content",
              "kind": "children",
              "minItems": 1,
              "maxItems": 8,
              "accepts": [
                {
                  "entrypoint": ".",
                  "exportName": "Button"
                }
              ]
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
      "tokens": [
        {
          "name": "color.action.primary",
          "label": "Action primary",
          "cssVariable": "--color-action-primary",
          "properties": ["color", "backgroundColor"],
          "description": "Primary interactive foreground and fill."
        },
        {
          "name": "radius.control",
          "label": "Control radius",
          "cssVariable": "--radius-control",
          "properties": ["borderRadius"]
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

Component slots are optional data-only composition contracts. Desktop v1
supports one `kind: "children"` collection per component. `minItems` and
`maxItems` constrain its direct React element children; `accepts` references
exact component exports declared by the same package. The main process resolves
the authored named import and validates the source and destination slots before
issuing a short-lived move capability. The renderer cannot infer slot legality
from DOM nesting or computed styles.

Tokens are explicit CSS custom-property references, not values parsed from
arbitrary token files. A token declares the appearance properties where it is
valid. Desktop adds exact package, version, and artifact-digest provenance,
then issues a capability-scoped token identity. Applying a token writes only
`var(--declared-name)` through the governed source transaction; an unlisted
custom property cannot impersonate a package token.

Patterns and templates do not contain JSX, arbitrary imports, scripts, or
remote runtime references. Both therefore use the same host-authorized React
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
- Slot IDs use the same bounded lowercase identifier form as pattern IDs.
  Labels are required and bounded to 80 bytes. Item limits are safe integers
  from 0 through 256, with the minimum no greater than the maximum.
- A component may declare at most eight slots, slot IDs and kinds must be
  unique, and Desktop v1 accepts only the `children` kind. Each `accepts` list
  contains at most 32 unique entrypoint/export pairs already declared in the
  same package.
- Every component entrypoint must also exist in the package `exports` map.
- A package may declare at most 256 tokens. Token names and CSS variables must
  be unique within the package; CSS variables use a bounded `--name` form.
- Each token supports one or more of `color`, `backgroundColor`, `fontSize`,
  `lineHeight`, `letterSpacing`, `borderRadius`, `padding`, or `margin`.

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
or changes to the active design-system compiler modules and their attested
artifact digests replace the catalog/build identity, so previously issued story
capabilities cannot render stale source or a different package activation.
The same trusted runtime can project a component's **Used in product** screen
list only when its executable prototype and component catalog validate as one
exact project/revision pair. The renderer receives screen identity, route, and
linked story IDs; source pointers, action ports, fixtures, and validation
details remain in the main process. Missing, malformed, cross-project, or stale
prototype evidence produces no usage claims.
Package-provided stories remain unavailable unless their trusted host adapter
can prove and compile the declared package revision; the renderer never imports
them directly.

The generated Bun repository uses the same stable component/story identity for
its real CSF files and writes a validated `selene-component-catalog/v1` directly
to `selene/component-catalog.json`. Its Storybook output directory and build
identity are therefore portable handoff metadata, not a lossy copy of the
Desktop Assets projection.

Developer handoffs identify stories with
`selene-canonical-story-reference/v1`: project, exact catalog revision,
Storybook build, component, and story. Federated shell projections retain those
tuples plus component ownership and design-system package versions, but do not
copy child code or expose Storybook deployment and filesystem authority.

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

Direct manipulation uses those same package contracts. Pointer drag and the
keyboard structure controls may reorder a child within its declared collection
or move it to another compatible collection. The source edit preserves the
complete authored JSX slice, including keys, props, comments, and stable Selene
node identity. A missing slot, incompatible component type, item-limit
violation, ambiguous import, or conditional/map structure leaves source
unchanged and produces an actionable canvas message.

For an existing mapped React element, **Replace** swaps only the opening and
closing component type plus declared catalog properties. The exact stable node
marker and existing React children are preserved, so review threads and
selection identity survive the change. The replacement is compiler-validated
before persistence; incompatible children, import conflicts, stale revisions,
and unapproved exports fail without mutating source.

When the selected compiler-mapped element is a named import from an enabled
package, the Inspect panel resolves that import against the exact staged
package/version/artifact receipt and exposes the component's declared property
controls. Current values are reported only for authored bounded JSX literals;
spread-backed, ambiguous, expression-backed, undeclared, stale, or disabled
package state fails closed. Applying one control consumes a short-lived opaque
capability and commits a typed `set-prop` proposal through the same
compile/persist/revision/undo path as other manual and AI edits. The renderer
never submits a package name, import, source path, JSX expression, or arbitrary
property schema.
