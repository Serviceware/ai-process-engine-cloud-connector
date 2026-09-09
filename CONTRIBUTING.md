# Contributing

Thank you for improving the Cloud Connector.

## Make a change

1. Create a branch.
2. Keep the change focused on the connector's proxy role.
3. Add or update tests where behaviour changes.
4. Run the repository checks.
5. Open a pull request with a short explanation of the change and its impact.

Use the Deno version from .dvmrc:

```bash
deno task ci
```

Please do not add credentials, generated build output, or unrelated
functionality. Configuration examples should use placeholder secrets.

For installation or release changes, keep the matching documentation brief and
operator-focused.
