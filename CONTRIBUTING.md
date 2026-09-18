# Contributing

Thank you for improving the Serviceware AI Process Engine - Cloud Connector.

## Make a change

1. Create a branch.
2. Keep the change focused on the connector's proxy role.
3. Add or update tests where behaviour changes.
4. Add a Changeset describing the user-visible impact. For changes that do not
   need a release, add an empty Changeset.
5. Run the repository checks.
6. Open a pull request with a short explanation of the change and its impact.

Use the Deno version from `.dvmrc`:

```bash
deno task ci
```

Create a release Changeset with `deno task changeset`. Select `patch`, `minor`,
or `major` and write a concise, user-facing summary. For documentation, tests,
or internal tooling that should not change the released version, use:

```bash
deno task changeset --empty
```

Please do not add credentials, generated build output, or unrelated
functionality. Configuration examples should use placeholder secrets.

For installation or release changes, keep the matching documentation brief and
operator-focused.
