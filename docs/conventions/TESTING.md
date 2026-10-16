# Testing conventions

Unit tests live next to the source as `*.spec.ts` and use `Deno.test`. A
behavior change requires focused tests for its success path, validation
failures, and important boundary conditions.

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
deno task test:integration
```

The connector binds its fixed probe port `8080`, so the integration tests run
sequentially and need that port free. Behind an HTTP proxy, add `127.0.0.1` to
`NO_PROXY` so the test runner reaches the connector probes directly. The SIGTERM
and SIGINT tests are skipped on Windows.

## Required verification

Run the smallest relevant checks while developing. Before completing a change,
run:

```bash
deno task ci
```

This checks formatting, linting, types, tests, generated API models, and release
artifacts. Also run `git diff --check`.

When Compose examples change, validate both files:

```bash
docker compose --file templates/starter/docker-compose.yml config --quiet
docker compose --file templates/examples/ticketing-yaml/docker-compose.yml config --quiet
```

When the Dockerfile, runtime permissions, startup configuration, or health
behavior changes, build the image and perform a container smoke test equivalent
to the CI workflow.

Do not update assertions only to make a failing test pass. Confirm whether the
implementation or the documented contract is wrong first.
