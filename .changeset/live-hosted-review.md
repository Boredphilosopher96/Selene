---
'@selene/collaboration': patch
---

Add an optional hosted-review invalidation subscription so collaboration clients can refresh
revision-bound threads when another reviewer changes them. Preserve every durable event while a
client reconnects by subscribing before paginated replay and recovering concurrent updates in
durable cursor order. Support cookie-authenticated browser requests from explicitly configured
origins and refresh review state when the event stream reconnects.
