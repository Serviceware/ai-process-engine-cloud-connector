---
"@serviceware/cloud-connector": minor
---

Run the Cloud Connector on Node.js 24 instead of Deno. The container image is
based on `node:24-bookworm-slim` and keeps file access restricted with the
Node.js permission model. Configuration and behavior are unchanged.
