# Edge Connector release guide

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
deno task ci

docker build --pull --tag ghcr.io/serviceware/cloud-connector:3.0.0 .
docker compose --file templates/starter/docker-compose.yml config --quiet
docker compose --file templates/examples/ticketing-yaml/docker-compose.yml config --quiet
```

Smoke-test with the starter YAML mounted:

```bash
docker run --rm --detach \
  --name edge-connector-release-smoke \
  --publish 18080:8080 \
  --env CLOUD_CONNECTOR_FORWARDING_CONFIG=/config/forwarding.yml \
  --env INTERNAL_API_URL=https://internal.example \
  --env OUTBOUND_URL_ALLOWLIST='[]' \
  --volume "$PWD/templates/starter/forwarding.yml:/config/forwarding.yml:ro" \
  ghcr.io/serviceware/cloud-connector:3.0.0

curl --fail http://localhost:18080/health
docker inspect --format '{{.State.Health.Status}}' edge-connector-release-smoke
docker stop edge-connector-release-smoke
```

Before approval, also confirm:

- no `.ts`, `.js`, `.mjs`, `.cjs`, `.py`, or SDK files exist below `templates/`;
- no dynamic import or evaluated customer content remains in `runtime/`;
- an absolute inbound URL cannot replace the YAML target origin;
- the empty allowlist blocks before network I/O;
- initial and redirected allowed requests succeed only when matched;
- malformed and missing YAML fail startup;
- removed YAML customization fields such as conditions, body/status changes, and
  arbitrary URL rewrites fail validation; and
- documentation and examples use only Edge Connector and FLAMOX365 naming.

## Publish

After merging the verified commit, create and push the annotated release tag:

```bash
git tag --annotate v3.0.0 --message "Edge Connector 3.0.0"
git push origin v3.0.0
```

The `Release container` workflow reruns every required check, verifies the
release contract, publishes version and major container tags, creates an SBOM
and build-provenance attestation, and smoke-tests the published digest. Protect
the `release` GitHub environment with the required reviewers.

Move `latest` only after the release is approved as the production default. Run
the manual `Promote release to latest` workflow with the released semantic
version. It retags the immutable published image without rebuilding it. Protect
the `production` GitHub environment with the required reviewers.
