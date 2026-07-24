# Portable schemas

These JSON Schema documents are versioned portable contracts. They use JSON
Schema draft 2020-12 and can be consumed by any compliant validator. They do not
require a Selene package, backend, or agent provider.

## Validate without project dependencies

If Python 3 is available, validate JSON syntax and inspect JSONL shape with:

```sh
python3 -m json.tool schemas/agent-protocol/v1/envelope.schema.json >/dev/null
python3 -m json.tool schemas/project-federation/v1/manifest.schema.json >/dev/null
awk 'NF { print }' schemas/agent-protocol/v1/fixtures/valid.jsonl | \
  while IFS= read -r line; do printf '%s' "$line" | python3 -m json.tool >/dev/null; done
```

Run the dependency-free conformance checks for the protocol fixtures with:

```sh
node schemas/agent-protocol/v1/validate-fixtures.mjs
```

The checker exercises the v1 envelope invariants represented by the fixtures;
it is intentionally not a replacement for a full draft 2020-12 validator.

For full schema validation, point any draft 2020-12 validator at the schema and
each one-line object. Invalid fixtures intentionally fail validation and are
documented beside the schema.
