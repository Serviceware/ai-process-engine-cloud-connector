# Changelog

All notable changes to the Serviceware AI Process Engine - Cloud Connector are
documented in this file. Releases follow
[Semantic Versioning](https://semver.org/).

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
