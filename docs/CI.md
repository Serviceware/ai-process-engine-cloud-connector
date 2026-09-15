# Repository checks

Run all local checks with:

```bash
deno task ci
```

This checks formatting, linting, types, tests, and generated protocol files.

GitHub Actions runs the same checks for pull requests and also verifies the
container image. It also requires every non-release pull request to contain a
valid Changeset; use an empty Changeset for work that should not create a new
release. Keep pull requests green before merging.

An authorized maintainer starts the Deno release workflow manually when a
release is wanted. It creates or updates one release pull request. After that
pull request is merged, another manual run creates the semantic version tag and
GitHub Release, then publishes the matching container image.
