# Testing conventions

Unit tests live next to the source as `*.spec.ts` and use Vitest. A behavior
change requires focused tests for its success path, validation failures, and
important boundary conditions.

Prefer deterministic unit tests. Inject time, network, filesystem, and
randomness dependencies where practical. Do not call real Serviceware or target
systems from unit or integration tests; only the end-to-end suite calls a real
Serviceware AI Process Engine tenant.

## Integration tests

`integration/` runs `runtime/main.ts` as a separate process with the production
permissions against local stubs:

- `stub-ai-process-engine.ts` serves `.well-known`, the client-credentials token
  endpoint, and the connector WebSocket endpoint, and sends request frames as
  Serviceware AI Process Engine would.
- `stub-target.ts` is the internal HTTP service and records forwarded requests.

Cover connector behavior visible across the process boundary there: protocol
frames, forwarding policy, reconnects, hot reload, probes, signals, and exit
codes. Keep fine-grained cases in unit tests.

```bash
pnpm run test:integration
```

The connector binds its fixed probe port `8080`, so the integration tests run
sequentially and need that port free. Behind an HTTP proxy, add `127.0.0.1` to
`NO_PROXY` so the test runner reaches the connector probes directly. The SIGTERM
and SIGINT tests are skipped on Windows.

### Against the container image

With `INTEGRATION_TEST_IMAGE` set, the same specs run the image instead of
`runtime/main.ts`, the way customers do: `docker run --network host`, the
temporary directory mounted read-only at `/config`, the image's own command,
and signals sent through `docker kill`. Exit codes come from the container.
The CI `container` job runs this mode against the image it builds.

```bash
docker build --tag cloud-connector:local .
INTEGRATION_TEST_IMAGE=cloud-connector:local pnpm run test:integration
```

This mode needs Linux and a Docker daemon that shares the test's network and
filesystem: the stubs listen on `127.0.0.1`, and the daemon mounts the
temporary directory by its path. In a container with the Docker socket, run with
`--network host` and mount the temporary directory at the same path on both
sides, for example `-v /tmp/it:/tmp/it -e TMPDIR=/tmp/it`.

## End-to-end tests

`e2e/` runs the connector against a real Serviceware AI Process Engine tenant.
It is the only suite that calls a Serviceware system. The suite starts
`stub-target.ts` and one connector with the integration harness, then asks the
platform to send requests through it with
`POST /configuration-store/api/v1/connector/{purpose}/http`. It covers what
only the real platform shows: authentication against the tenant's Keycloak
realm, the connector WebSocket, request and response mapping, how connector
errors such as `OUTBOUND_URL_NOT_ALLOWED` reach the caller, and what the
platform's monitoring API records: the request log
(`GET .../connector/{purpose}/http`, filtered by a per-test initiator), the
connector, and its sessions.

Each run registers its own purpose, so runs on different machines can share the
tenant. In GitHub Actions the purpose is `e2e-<run ID>`, which links platform
requests to the workflow run; a re-run attempt reuses it. Local runs use
`e2e-local-<uuid>`. Tests within a run share that connector and run
concurrently. The suite does not delete the purpose, and a
tenant reset keeps purposes (AB#155559), so one disconnected purpose remains per
run.

Set the tenant and an OAuth service account with the **Advanced Cloud
Connector** permission, which connects and sends requests, and the **Cloud
Connector administration** permission, which reads the monitoring API. The suite resolves the Keycloak issuer from the
tenant's `.well-known` configuration:

```bash
export E2E_CLOUD_CONNECTOR_HOST="https://dev-e2e.ai-process-engine.labs.swops.cloud"
export E2E_CLOUD_CONNECTOR_CLIENT_ID="<client id>"
read -rsp "Client secret: " E2E_CLOUD_CONNECTOR_CLIENT_SECRET; echo
export E2E_CLOUD_CONNECTOR_CLIENT_SECRET
pnpm run test:e2e
```

Instead of exporting them, you can put the three variables into a `.env` file
in the repository root. Git ignores it, and variables set in the shell take
precedence over it:

```dotenv
E2E_CLOUD_CONNECTOR_HOST=https://dev-e2e.ai-process-engine.labs.swops.cloud
E2E_CLOUD_CONNECTOR_CLIENT_ID=<client id>
E2E_CLOUD_CONNECTOR_CLIENT_SECRET=<client secret>
```

Like the integration tests, the suite needs probe port `8080` and runs against
the image when `INTEGRATION_TEST_IMAGE` is set. `pnpm run ci` does not include
it. CI runs it on `main` and on manual runs; see
[Repository checks](../CI.md#end-to-end-tests).

## Required verification

Run the smallest relevant checks while developing. Before completing a change,
run:

```bash
pnpm run ci
```

This checks formatting, linting, types, tests, generated API models, and release
artifacts. Also run `git diff --check`.

When Compose examples change, validate both files:

```bash
docker compose --file templates/starter/docker-compose.yml config --quiet
docker compose --file templates/examples/ticketing-yaml/docker-compose.yml config --quiet
```

When the Dockerfile, runtime permissions, startup configuration, or health
behavior changes, build the image, run the integration tests against it, and
perform a container smoke test equivalent to the CI workflow.

Do not update assertions only to make a failing test pass. Confirm whether the
implementation or the documented contract is wrong first.
