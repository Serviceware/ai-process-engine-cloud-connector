# Development conventions

## Toolchain

Node.js is the repository's only JavaScript and TypeScript runtime. Use the
version from `.node-version`, keep scripts in the root `package.json`, and
commit `package-lock.json` when dependencies change. Install with `npm ci`. Do
not add a second package manager or task runner.

Node.js runs the TypeScript sources directly through type stripping; there is
no build step. Use only erasable TypeScript syntax (`erasableSyntaxOnly`): no
`enum`, `namespace`, or constructor parameter properties. Import local modules
with their `.ts` extension.

The toolchain is TypeScript 7 (`tsc`) for type checking, oxfmt for formatting,
oxlint for linting, and Vitest for tests.

Common commands:

```bash
npm run fmt
npm run lint
npm run typecheck
npm run test
npm run ci
```

## Implementation style

- Use strict TypeScript types at module boundaries.
- Keep modules focused and use dependency injection for clocks, fetch functions,
  and other external effects that tests must control.
- Validate untrusted input before it reaches runtime logic.
- Prefer immutable validated configuration snapshots.
- Use `RuntimeError` and stable error codes for expected runtime failures.
- Keep logging structured enough to diagnose failures without exposing secrets.

Let oxfmt define formatting. Follow the existing naming and import style
instead of introducing local formatting exceptions.

## Generated artifacts

Change `openapi/api.yml`, then run `npm run generate:api` to update protocol
models. Coordinate every change to this shared protocol with the Serviceware AI
Process Engine backend before merging it. Never edit `runtime/generated/`
directly. Run `npm run generate:check` before completion whenever the protocol
or generation path changes.

The release version in `package.json`, release headings in `CHANGELOG.md`, and
versioned image references are maintained by the release workflow. Do not edit
them as part of ordinary feature work.

## Scope

Keep changes focused. Do not mix refactors, generated-file churn, dependency
updates, and behavior changes unless they are required for the same outcome.
Preserve unrelated local changes in the working tree.
