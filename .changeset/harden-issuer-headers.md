---
"@serviceware/cloud-connector": patch
---

Reject an `http:` control-plane issuer when the Cloud host uses `https:`,
validate OAuth2 issuers from environment variables before requesting tokens,
reject fragments in OAuth2 issuers, apply header remove, set, and add operations
across matching rules in order, and report invalid OAuth2 token responses,
failed health checks, and failed response bodies with clear errors.
