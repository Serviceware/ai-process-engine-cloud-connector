# Development conventions

## Toolchain

Deno is the repository's only JavaScript and TypeScript runtime. Use the version
from `.dvmrc`, keep tasks in the root `deno.json`, and commit `deno.lock` when
dependencies change. Do not add Node.js package manifests or a second task
runner.

Common commands:

```bash
deno task fmt
deno task lint
deno task typecheck
deno task test
deno task ci
```

## Implementation style

- Use strict TypeScript types at module boundaries.
- Keep modules focused and use dependency injection for clocks, fetch functions,
  and other external effects that tests must control.
- Validate untrusted input before it reaches runtime logic.
- Prefer immutable validated configuration snapshots.
- Use `RuntimeError` and stable error codes for expected runtime failures.
- Keep logging structured enough to diagnose failures without exposing secrets.

Let `deno fmt` define formatting. Follow the existing naming and import style
instead of introducing local formatting exceptions.

## Generated artifacts

Change `openapi/api.yml`, then run `deno task generate:api` to update protocol
models. Coordinate every change to this shared protocol with the Serviceware AI
Process Engine backend before merging it. Never edit `runtime/generated/`
directly. Run `deno task generate:check` before completion whenever the protocol
or generation path changes.

The release version in `deno.json`, release headings in `CHANGELOG.md`, and
versioned image references are maintained by the release workflow. Do not edit
them as part of ordinary feature work.

## Scope

Keep changes focused. Do not mix refactors, generated-file churn, dependency
updates, and behavior changes unless they are required for the same outcome.
Preserve unrelated local changes in the working tree.
