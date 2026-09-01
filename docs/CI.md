# Edge Connector repository validation

GitHub Actions applies the same checks that contributors run locally. Deno is
pinned through `.dvmrc`; the Dockerfile uses the same runtime version and the
same root lock file.

## Local validation

Run the complete repository validation before pushing:

```bash
deno task ci
```

The aggregate task performs, in order:

1. a repository-wide format check;
2. Deno linting;
3. type-checking of the complete `runtime/` tree with a frozen lock file;
4. every `runtime/*.spec.ts` test with only environment, read, and write
   permissions; and
5. regeneration, formatting, and Git-diff validation of the OpenAPI models.

Individual tasks remain available as `fmt:check`, `lint`, `typecheck`, `test`,
`test:coverage`, and `generate:check`.

## Pull request validation

The `CI` workflow runs for every pull request, for pushes to `main`, and on
manual dispatch. It contains these jobs:

- `Quality` checks whitespace, formatting, linting, and types.
- `Test` publishes JUnit and source-only LCOV artifacts.
- `Generated contracts` proves that committed API models match the OpenAPI
  source.
- `Container smoke test` validates maintained Compose files, builds the image,
  and waits for the Edge Connector health check.
- `Required` is the stable aggregate status for branch protection.

Configure the `CI / Required` status as the required branch-protection check.
Pull request jobs receive read-only repository access and no secrets.

Third-party and GitHub-maintained actions are pinned to complete commit hashes.
Dependabot proposes grouped weekly updates for those pins.

## Delivery

`Release container` is triggered by a `vMAJOR.MINOR.PATCH` tag and publishes the
existing technical GHCR image name. It never moves `latest`. The separate,
manual `Promote release to latest` workflow promotes an already published
version without rebuilding it.

Configure required reviewers for both GitHub environments:

- `release` controls publication of versioned and major tags;
- `production` controls promotion to `latest`.

The technical image name, existing environment variables, and established API
identifiers remain unchanged for compatibility. User-facing names use Edge
Connector and FLAMOX365.
