---
"@serviceware/cloud-connector": patch
---

Keep `CLOUD_CONNECTOR_MAX_CONCURRENT_REQUESTS` across reconnects. Requests that
outlast the drain before a reconnect now count against the limit on the new
connection, which rejects excess requests with `TOO_MANY_REQUESTS` instead of
sending more requests to internal targets than the limit allows.
