---
"@serviceware/cloud-connector": minor
---

Run the Cloud Connector on Node.js 24 instead of Deno. The container image is
based on the Node.js 24 `bookworm-slim` image and keeps file access restricted with the
Node.js permission model. The configuration format is unchanged.

The container now runs as uid 1000 instead of 1993, so mounted configuration
files must be readable by uid 1000. `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`
keep working; trust an internal certificate authority with
`NODE_EXTRA_CA_CERTS` instead of `DENO_CERT`.
