# Security conventions

The forwarding configuration is a security boundary. Treat changes to target
matching, URL parsing, headers, authentication, redirects, DNS behavior, or
timeouts as security-sensitive.

## Deny by default

- Deny requests that match no forwarding rule.
- Match policies against the complete absolute target URL.
- Accept only HTTP and HTTPS targets.
- Keep target regular expressions anchored and reject unsafe expressions.
- Apply the outbound URL policy to every target request and OAuth token request.
- Revalidate redirect destinations; do not allow redirects to bypass policy.

Do not broaden a target rule in an example merely to make setup easier.

## Credentials and headers

Strip inbound `authorization`, `cookie`, and `proxy-authorization` headers
unless a rule explicitly opts into forwarding caller credentials. Connector
authentication must replace, not accidentally combine with, inbound credentials.

Keep target secrets in environment variables or the deployment platform's secret
store. Avoid logging configuration snapshots, authorization headers, tokens,
client secrets, or target response bodies.

## Resource bounds

Preserve finite connection, token, forwarding, and drain timeouts. Preserve
concurrency and response-size limits. Responses are buffered as UTF-8 text, so
reject oversized or unsupported binary responses predictably.

Errors sent over the cloud protocol should be stable and useful without
revealing internal addresses, credentials, or stack traces.

## Runtime permissions and dependencies

Keep the production Deno permission set limited to the network, environment, and
read access needed by the connector. Add dependencies only when the standard
library or a small local implementation is insufficient. Pin dependencies in
`deno.lock` and preserve frozen resolution in CI and the container build.
