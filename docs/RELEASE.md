# Cloud Connector release guide

Version `3.0.0` is a breaking security release. Workload access changes to
default-deny and customer scripting, the SDK, file-based routes, and transparent
proxy fallback are removed. A deployment must provide one valid YAML forwarding
configuration.

## Release contract

For one release, these values must agree:

- release version and Git tag, for example `3.0.0` and `v3.0.0`;
- container tags in maintained compose examples; and
- the matching `CHANGELOG.md` entry.

There is no SDK artifact to publish.

## Upgrade requirements

Before replacing an earlier deployment:

1. remove customer TypeScript/JavaScript function mounts and SDK dependencies;
2. consolidate forwarding behavior into one `forwarding.yml`;
3. set `CLOUD_CONNECTOR_FORWARDING_CONFIG` to its container path;
4. configure `OUTBOUND_URL_ALLOWLIST` for the YAML target and approved
   redirects; and
5. restart the container after every YAML change.

Without a readable, valid YAML file, startup fails. Without an explicit
allowlist, startup succeeds but every workload target is rejected.

## Pre-release verification

Use Deno `2.8.1`, matching the production image:

```bash
git diff --check
deno task check
deno task lint
deno task test

docker build --pull --tag ghcr.io/serviceware/cloud-connector:3.0.0 .
docker compose --file templates/starter/docker-compose.yml config --quiet
docker compose --file templates/examples/ticketing-yaml/docker-compose.yml config --quiet
```

Smoke-test with the starter YAML mounted:

```bash
docker run --rm --detach \
  --name cloud-connector-release-smoke \
  --publish 18080:8080 \
  --env CLOUD_CONNECTOR_FORWARDING_CONFIG=/config/forwarding.yml \
  --env INTERNAL_API_URL=https://internal.example \
  --env OUTBOUND_URL_ALLOWLIST='[]' \
  --volume "$PWD/templates/starter/forwarding.yml:/config/forwarding.yml:ro" \
  ghcr.io/serviceware/cloud-connector:3.0.0

curl --fail http://localhost:18080/health
docker inspect --format '{{.State.Health.Status}}' cloud-connector-release-smoke
docker stop cloud-connector-release-smoke
```

Before approval, also confirm:

- no `.ts`, `.js`, `.mjs`, `.cjs`, `.py`, or SDK files exist below `templates/`;
- no dynamic import or evaluated customer content remains in `runtime/`;
- an absolute inbound URL cannot replace the YAML target origin;
- the empty allowlist blocks before network I/O;
- initial and redirected allowed requests succeed only when matched;
- malformed and missing YAML fail startup; and
- documentation and examples use only Cloud Connector and Serviceware Cloud
  naming.

## Publish

After merging the verified commit:

```bash
git tag --annotate v3.0.0 --message "Cloud Connector 3.0.0"
git push origin v3.0.0
docker push ghcr.io/serviceware/cloud-connector:3.0.0
docker tag ghcr.io/serviceware/cloud-connector:3.0.0 \
  ghcr.io/serviceware/cloud-connector:3
docker push ghcr.io/serviceware/cloud-connector:3
```

Move `latest` only when the release is approved as the production default.
Record the image digest and release URL after pulling and repeating the smoke
test on a clean host.
