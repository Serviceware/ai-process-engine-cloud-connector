# Changelog

All notable changes to the Serviceware AI Process Engine - Cloud Connector are
documented in this file. Releases follow
[Semantic Versioning](https://semver.org/).

## 1.1.0 - 2026-10-22

### Added

- Run the Cloud Connector on Node.js 24 instead of Deno. The container image is based on the Node.js 24 `bookworm-slim` image and keeps file access restricted with the Node.js permission model. The configuration format is unchanged. The container now runs as uid 1000 instead of 1993, so mounted configuration files must be readable by uid 1000. Trust an internal certificate authority with `NODE_EXTRA_CA_CERTS` instead of `DENO_CERT`. `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` still apply; `HTTP_PROXY` now also covers HTTPS targets when `HTTPS_PROXY` is unset, and `NO_PROXY` does not accept CIDR ranges. URLs with embedded credentials are no longer accepted for `CLOUD_CONNECTOR_HOST` or OAuth2 issuers.

### Fixed

- Run on Node.js 24.22.1 to stop trusting the compromised eMudhra certificate authorities. In October 2026 the private keys of eight eMudhra intermediate certificate authorities were exposed, so anyone holding them can issue certificates that look valid for any host name. Node.js checks TLS certificates against the root certificates built into its binary and does not check revocation, so earlier Cloud Connector images keep trusting certificates issued with those keys. Node.js 24.22.1 removes three emSign root certificates and rejects certificate chains that contain one of the compromised keys. This protects the connection to the AI Process Engine and to forwarded targets against interception by an attacker who holds one of these keys. Update all deployments to this release. Running the connector outside the container image now requires Node.js 24.22.1 or later.

## 1.0.2 - 2026-10-06

### Fixed

- Use the authentication issuer returned by the Cloud context without comparing
  it to the Cloud Connector host or a fixed identity-provider domain.

## 1.0.1 - 2026-09-28

### Fixed

- Allow Cloud Connector authentication through Serviceware SSO, publish `latest`
  with each new release, and keep non-pullable provenance attestations out of
  GHCR image tags.

## 1.0.0 - 2026-09-21

### Major changes

- Publish the first stable Cloud Connector release with hot-reloadable YAML
  forwarding, default-deny outbound rules, and a multi-platform container image.

## 0.1.0 - 2026-08-31

### Added

- Added one complete, mounted `cloud-connector.yml` for connection, logging, and
  ordered target-regex forwarding rules.
- Hot reloads validated YAML changes without restarting the container or
  application.
- Keeps the last-known-good snapshot when a file update is unreadable or
  invalid.
- Reconnects only when socket-level YAML settings change; forwarding and log
  settings switch in place.
- Supports Basic, Bearer, and OAuth 2.0 client-credentials authentication for
  forwarded requests, including environment-backed secrets and token caching.

### Security

- Denies workload HTTP access unless a complete target URL matches at least one
  forwarding rule.
- Revalidated every HTTP redirect target before following it and limited
  redirect chains to 20 hops.
- Removed authorization, proxy authorization, and cookie credentials when a
  redirect crosses an origin boundary.
- Kept the required Serviceware AI Process Engine OAuth and WebSocket
  control-plane traffic outside the workload policy.
- Added the stable `OUTBOUND_URL_NOT_ALLOWED` runtime error code.

### Changed

- Limited the connector to declarative YAML forwarding; executable customer
  customization and the local inbound WebSocket endpoint are not supported.
- Derives the Serviceware WebSocket URL from `CLOUD_CONNECTOR_HOST` and the
  connection purpose, which defaults to `main`.
- Pinned maintained container examples to `0.1.0` instead of `latest`.

### Fixed

- Corrected the container health-check path.
- Cached production dependencies with the runtime configuration so the Docker
  build context no longer references templates that are not copied into the
  image.
- Removed package metadata from application templates to avoid misleading Deno
  package-export warnings.
