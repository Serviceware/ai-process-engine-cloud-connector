# Testing conventions

Tests live next to the source as `*.spec.ts` and use `Deno.test`. A behavior
change requires focused tests for its success path, validation failures, and
important boundary conditions.

Prefer deterministic unit tests. Inject time, network, filesystem, and
randomness dependencies where practical. Do not call real Serviceware or target
systems from the test suite.

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
