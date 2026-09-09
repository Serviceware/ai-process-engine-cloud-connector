# Changelog

All notable changes to the Cloud Connector are documented in this file. Releases
follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Breaking changes

- Replaced the forwarding-only file and operational environment variables with
  one complete, mounted `cloud-connector.yml`.
- Moved the Serviceware WebSocket URL, heartbeat interval, log level, forwarding
  target, and outbound URL allowlist into YAML.
- Removed the local inbound `/ws` endpoint, optional cloud connection,
  configurable internal listen address, and configurable internal port.
- Serviceware host and OAuth credentials remain required environment settings;
  low-level reconnect, token, watchdog, and liveness tuning remains optional
  environment configuration.

### Added

- Hot reloads validated YAML changes without restarting the image, container, or
  application.
- Keeps the last-known-good snapshot when a file update is unreadable or
  invalid.
- Reconnects only when socket-level YAML settings change; forwarding and log
  settings switch in place.

## 3.0.0 - 2026-08-31

### Breaking changes

- Workload HTTP access is now denied by default. Deployments must configure
  `OUTBOUND_URL_ALLOWLIST` as a JSON array of regular expressions before the
  Cloud Connector can reach internal or external workload URLs.
- An absent variable and `OUTBOUND_URL_ALLOWLIST=[]` both deny every workload
  URL. `OUTBOUND_URL_ALLOWLIST=[".*"]` is the explicit, unrestricted opt-out and
  should only be used after a security review.
- Customer TypeScript, JavaScript, and other executable customization is no
  longer supported. The SDK, dynamic module loader, file-based routes, and
  script examples were removed.
- Every deployment must provide one YAML forwarding file through
  `CLOUD_CONNECTOR_FORWARDING_CONFIG`. Missing or invalid YAML fails startup.
- The transparent absolute-URL proxy fallback was removed. An inbound request
  cannot select a target origin.

### Security

- Enforced the outbound URL allowlist for the YAML forwarding target and every
  redirect destination.
- Revalidated every HTTP redirect target before following it and limited
  redirect chains to 20 hops.
- Removed authorization, proxy authorization, and cookie credentials when a
  redirect crosses an origin boundary.
- Kept the required Serviceware Cloud OAuth and WebSocket control-plane traffic
  outside the workload policy.
- Added the stable `OUTBOUND_URL_NOT_ALLOWED` runtime error code.

### Changed

- Replaced function routing and hot reload with one startup-validated,
  declarative `forwarding.yml` execution path.
- Limited YAML to one target, method restrictions, timeout, headers, and one
  static path prefix. Removed conditions, body/status manipulation, and
  arbitrary URL rewrites from the configuration contract.
- Documented default-deny configuration, safe regular-expression examples, and
  the YAML-only deployment migration.
- Pinned maintained container examples to `3.0.0` instead of `latest`.

### Fixed

- Corrected the container health-check path.
- Cached production dependencies with the runtime configuration so the Docker
  build context no longer references templates that are not copied into the
  image.
- Removed package metadata from application templates to avoid misleading Deno
  package-export warnings.
