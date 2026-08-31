# Cloud Connector Release Guide

This guide is the maintainer checklist for releasing the Cloud Connector and its
SDK. Version `3.0.0` is a major release because workload HTTP access changes from
implicit access to default-deny.

## Release contract

For one release, these values must agree:

- the release and Git tag, for example `3.0.0` and `v3.0.0`;
- `version` in `sdk/deno.json`;
- the SDK major used by maintained TypeScript templates;
- the container tag in maintained deployment examples;
- the matching entry in `CHANGELOG.md`.

Do not publish from a dirty checkout. Build every artifact from the exact commit
that receives the release tag.

## Upgrade requirement for 3.0.0

Configure `OUTBOUND_URL_ALLOWLIST` before upgrading an existing deployment.
Without an explicit allowlist, the Cloud Connector starts normally but rejects
all workload HTTP targets and redirects with `OUTBOUND_URL_NOT_ALLOWED`.

Use anchored expressions and include a hostname boundary:

```env
# Permit one HTTPS host and every path on it
OUTBOUND_URL_ALLOWLIST=["^https://api[.]example[.]com(?:/|$)"]

# Permit two internal targets
OUTBOUND_URL_ALLOWLIST=["^https://api[.]example[.]com(?:/|$)","^http://erp:8080(?:/|$)"]
```

Keep `[]` when workload HTTP must remain disabled. The explicit unrestricted
configuration `OUTBOUND_URL_ALLOWLIST=[".*"]` should be temporary or backed by a
documented security decision. The Serviceware Cloud OAuth and WebSocket connection does
not need an entry.

## Pre-release verification

Use Deno `2.8.1`, matching the production image, and a current Docker/Compose
installation.

```bash
git diff --check
deno task check
deno task lint
deno task test
(cd sdk && deno publish --dry-run)

docker build --pull \
  --tag ghcr.io/serviceware/cloud-connector:3.0.0 .

docker compose --file templates/starter/docker-compose.yml config --quiet
docker compose --file templates/examples/ad-user-export/docker-compose.yml config --quiet
docker compose --file templates/examples/erp-integration/docker-compose.yml config --quiet
docker compose --file templates/examples/ticketing-yaml/docker-compose.yml config --quiet
```

Smoke-test the built image without cloud credentials:

```bash
docker run --rm --detach \
  --name edge-connector-release-smoke \
  --publish 18080:8080 \
  --env OUTBOUND_URL_ALLOWLIST='[]' \
  ghcr.io/serviceware/cloud-connector:3.0.0

curl --fail http://localhost:18080/health
docker inspect --format '{{.State.Health.Status}}' edge-connector-release-smoke
docker stop edge-connector-release-smoke
```

The health endpoint must return HTTP 200 and the container must become
`healthy`. Review the changelog, generated diff, and dependency lock file before
approval. Confirm that no credentials, local environment files, or build output
are included.

## Publish

After the verified commit is merged, create and push the annotated tag:

```bash
git tag --annotate v3.0.0 --message "Cloud Connector 3.0.0"
git push origin v3.0.0
```

Publish the SDK and container from a clean checkout of that tag. Authentication
for JSR and the GitHub Container Registry must already be configured.

```bash
(cd sdk && deno publish)

docker push ghcr.io/serviceware/cloud-connector:3.0.0
docker tag ghcr.io/serviceware/cloud-connector:3.0.0 \
  ghcr.io/serviceware/cloud-connector:3
docker push ghcr.io/serviceware/cloud-connector:3
```

Move `latest` only when `3.0.0` is the approved default production release:

```bash
docker tag ghcr.io/serviceware/cloud-connector:3.0.0 \
  ghcr.io/serviceware/cloud-connector:latest
docker push ghcr.io/serviceware/cloud-connector:latest
```

Create the GitHub release from `v3.0.0` using the `3.0.0` changelog entry. Call
out the allowlist migration at the top of the release notes.

## Post-release verification

- Pull `ghcr.io/serviceware/cloud-connector:3.0.0` on a clean host.
- Repeat the health smoke test with the pulled image.
- Verify that an empty allowlist rejects a workload request and that an anchored
  test allowlist permits only its intended URL.
- Install `jsr:@serviceware/cloud-connector-sdk@3` in a clean Deno project and
  type-check a minimal function.
- Record the image digest and links to the GitHub and JSR releases in the release
  record.
