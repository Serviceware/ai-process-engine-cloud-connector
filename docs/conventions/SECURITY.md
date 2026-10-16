# Security conventions

The forwarding configuration is a security boundary. Treat changes to target
matching, URL parsing, headers, authentication, redirects, DNS behavior, or
timeouts as security-sensitive.

## Deny by default

- Deny requests that match no forwarding rule.
- Match policies against the complete absolute target URL.
- Accept only HTTP and HTTPS targets.
- Keep target regular expressions anchored and reject unsafe expressions.
- Apply the outbound URL policy to every forwarded target request. OAuth token
  requests use their configured issuer outside the target allowlist; reject
  token endpoint redirects. For the control plane, use the issuer returned by
  the platform's `.well-known` configuration.
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

The production container runs Node.js with the permission model
(`--permission`) and grants only file reads of the application (`/app/`) and the
mounted configuration (`/config/`). File writes, child processes, worker
threads, native addons, and WASI stay denied. The Node.js 24 permission model
does not restrict network or environment access; the outbound URL policy is the
network boundary; it is checked before a request reaches the proxy
configured by `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`. Keep the granted read
paths minimal.

Add dependencies only when the standard library or a small local implementation
is insufficient. Pin dependencies in `pnpm-lock.yaml` and preserve frozen
resolution (`pnpm install --frozen-lockfile`) in CI and the container build.
`pnpm-workspace.yaml` sets `minimumReleaseAge` to seven days, so pnpm rejects
package versions published more recently; do not lower it or add exclusions
without a reviewed reason.
