# Repository checks

Run all local checks with:

```bash
deno task ci
```

This checks formatting, linting, types, tests, and generated protocol files.

GitHub Actions runs the same checks for pull requests and also verifies the
container image. Keep pull requests green before merging.
