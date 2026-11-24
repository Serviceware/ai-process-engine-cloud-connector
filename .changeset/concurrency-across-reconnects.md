---
"@serviceware/cloud-connector": patch
---

Keep `CLOUD_CONNECTOR_MAX_CONCURRENT_REQUESTS` across reconnects, and cancel
forwarded requests whose platform connection is closing. Requests still running
when the drain times out, or when the platform connection closes, are now
cancelled instead of running until their forwarding timeout, because their
responses can no longer reach the platform. Before, a new connection could start
another full set of requests while the old ones still ran, so internal targets
could receive more requests than the limit allows.
