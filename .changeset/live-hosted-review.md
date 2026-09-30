---
'@selene/collaboration': patch
---

Add an optional hosted-review invalidation subscription so collaboration clients can refresh
revision-bound threads when another reviewer changes them. Preserve every durable event while a
client reconnects by subscribing before paginated replay and ordering any concurrent updates after
the recovered cursor.
