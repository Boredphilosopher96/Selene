---
'@selene/core': patch
---

Index node and transition references once per graph operation to avoid repeated
full scans when validating scenario paths or removing a transition. Preserve
graph validation errors, alternate wires, and longest-wired-prefix behavior.
