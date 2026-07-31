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
      "designLanguagePath": "./DESIGN.md"
    }
  }
}
```

Components identify real published React exports. Their optional properties
describe bounded boolean, number, text, or select controls. Patterns are curated
catalog aliases for one declared component export; they inherit that
component's properties and insertion policy.

Patterns do not contain JSX, arbitrary imports, slots, scripts, or remote
runtime references. A pattern therefore uses the same host-authorized React
insertion path as its component. The renderer cannot invent a package,
revision, target node, export, or artifact digest.

## Validation limits

- Pattern IDs use lowercase letters, numbers, and hyphens, begin with a letter,
  and are at most 64 characters.
- Labels are trimmed and at most 80 bytes; descriptions are trimmed and at
  most 512 bytes.
- A package may declare at most 64 patterns.
- Pattern IDs must be unique within the package.
- Every pattern must reference exactly one entrypoint/export pair already
  declared in `components`.
- Every component entrypoint must also exist in the package `exports` map.

Invalid or accessor-backed metadata is rejected before it reaches the Desktop
catalog. Staging package metadata does not install or activate package code.

## Desktop behavior

Approved components and patterns appear together in the Desktop Assets panel.
Patterns have a distinct badge and searchable description. Designers configure
the inherited property controls, select a mapped flex or grid React container,
then insert by button or catalog drag. The main process revalidates the
component identity, artifact digest, current source revision, selected node,
and property values before proposing a source edit.
