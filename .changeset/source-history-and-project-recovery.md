---
'@selene/core': patch
'@selene/collaboration': patch
---

Add safe source-subtree duplication with unique marker remapping and support atomic
duplicate batches in the portable edit adapter. Track flow and design-input changes
as generated-design baseline deltas. Require restore authorization and current
revision fencing when an import overwrites an existing collaboration project.
