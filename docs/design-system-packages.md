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

Approved components, patterns, and templates appear together in the Desktop
Assets panel. Patterns and screen/section templates have distinct badges and
searchable descriptions. Template presets initialize the same editable variant
controls used by their component. Designers select a mapped flex or grid React
container, then insert by button or catalog drag. The main process revalidates
the component identity, artifact digest, current source revision, selected node,
and final property values before proposing a source edit.
