---
"@serviceware/cloud-connector": major
---

Replace the forwarding-only environment configuration with one hot-reloadable
`cloud-connector.yml` containing connection, logging, and ordered target-regex
rules. Matching rules merge in declaration order and support per-target methods,
headers, timeouts, and Basic, Bearer, or OAuth 2.0 client-credentials auth.
Invalid updates keep the last-known-good configuration, while connection changes
reconnect the WebSocket and other changes apply to the next forwarded request.

Remove the local inbound WebSocket endpoint and executable customization paths.
Serviceware host and OAuth credentials remain required environment settings; the
WebSocket URL is derived from that host and a configurable purpose that defaults
to `main`. Low-level reconnect, token, watchdog, and liveness tuning stays
optional.

Publish attested release images for Linux AMD64 and ARM64 in the
repository-linked GitHub Container Registry package, with immutable
semantic-version tags, SBOMs, provenance attestations, and verified anonymous
pulls.
