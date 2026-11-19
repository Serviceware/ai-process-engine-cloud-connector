---
"@serviceware/cloud-connector": patch
---

Update undici from 7.30.0 to 7.30.2.
This fixes two ways a malicious or compromised HTTPS target could crash the connector: TLS 1.2 renegotiation with a certificate for another host name (CVE-2026-87018) and responses with more than five content codings (CVE-2026-109869).
