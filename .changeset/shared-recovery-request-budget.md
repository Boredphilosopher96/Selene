---
'@selene/collaboration': patch
---

Expose the service's configured request budget for host-handled routes and apply it
to authenticated project backup and restore requests before authorization or
storage work. Recovery and ordinary collaboration requests share the existing
bounded identity counters and minute window.
