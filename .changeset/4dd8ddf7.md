---
"@serviceware/cloud-connector": minor
---

Run the Cloud Connector on Node.js 24 instead of Deno. The container image is
based on the Node.js 24 `bookworm-slim` image and keeps file access restricted
with the Node.js permission model. The configuration format is unchanged.

The container now runs as uid 1000 instead of 1993, so mounted configuration
files must be readable by uid 1000. Trust an internal certificate authority
with `NODE_EXTRA_CA_CERTS` instead of `DENO_CERT`. `HTTP_PROXY`, `HTTPS_PROXY`,
and `NO_PROXY` still apply; `HTTP_PROXY` now also covers HTTPS targets when
`HTTPS_PROXY` is unset, and `NO_PROXY` does not accept CIDR ranges.
