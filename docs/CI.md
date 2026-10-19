# Repository checks

Run all local checks with:

```bash
pnpm run ci
```

This checks formatting, linting, types, unit and integration tests, and
generated protocol files.

GitHub Actions runs the same checks for pull requests and also verifies the
container image and that `.node-version` matches the Node.js version of the
`Dockerfile` base image. Dependabot updates only the `Dockerfile`, so set
`.node-version` in the same pull request. It also requires every non-release pull request to contain a
valid Changeset; use an empty Changeset for work that should not create a new
release. Dependabot pull requests are exempt; add a release Changeset to one if
the update should be released. Keep pull requests green before merging.

An authorized maintainer starts the release workflow manually when a
release is wanted. It creates or updates one release pull request. After that
pull request is merged, another manual run creates the semantic version tag and
GitHub Release, then publishes the matching container image.
