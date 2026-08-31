# Changelog

All notable changes to the Cloud Connector are documented in this file. Releases
follow [Semantic Versioning](https://semver.org/).

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
