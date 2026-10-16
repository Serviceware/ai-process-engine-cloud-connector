# Testing conventions

Unit tests live next to the source as `*.spec.ts` and use Vitest. A behavior
change requires focused tests for its success path, validation failures, and
important boundary conditions.

Prefer deterministic unit tests. Inject time, network, filesystem, and
randomness dependencies where practical. Do not call real Serviceware or target
systems from the test suite.

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
