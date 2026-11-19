# Repository checks

Run all local checks with:

```bash
pnpm run ci
```

This checks formatting, linting, types, unit and integration tests, generated
protocol files, release artifacts, and that `.node-version` matches the Node.js
version of the `Dockerfile` base image.

GitHub Actions runs the same checks for pull requests and also verifies the
container image. It requires every non-release pull request to contain a valid
Changeset; use an empty Changeset for work that should not create a new release.
Keep pull requests green before merging.

## Dependabot

Dependabot updates npm packages, GitHub Actions, and the digest-pinned
`Dockerfile` base image weekly, after a seven-day cooldown.

- A Dependabot pull request needs a Changeset only when it changes the
  `Dockerfile`, `.node-version`, or the `dependencies` in `package.json`, so the
  published image changes. Dev dependency and GitHub Actions updates do not.
- The **Dependabot release preparation** workflow handles both for Dependabot
  pull requests that change the `Dockerfile` or `package.json`. It sets
  `.node-version` to the base image's Node.js version and writes one `patch`
  Changeset per updated component: `.changeset/dependabot-node.md` for the base
  image and `.changeset/dependabot-<package>.md` for each runtime dependency. A
  later update of a component that is still unreleased extends its pending
  Changeset, for example to "Update undici from 7.30.0 to 7.30.2.", so each
  component appears once in the changelog.
- The workflow pushes one commit to the pull request branch. CI runs for that
  push wait for a maintainer's approval because the workflow token pushed it.
- For each Changeset it writes, the workflow opens a review conversation on the
  generated summary unless an open one exists. The `main` ruleset requires
  resolved conversations, so the pull request cannot merge until a reviewer
  checks the Changeset and resolves it.
- Add security context, such as fixed CVEs, on new lines after the generated
  first sentence; later updates keep it. The workflow fails when the first
  sentence was changed; then update the Changeset by hand.

## Image scan

The **Image scan** workflow scans the `latest` released image every Monday with
Trivy and uploads fixable high and critical vulnerabilities to code scanning.
Resolve a finding with a patch release: merge the Dependabot pull request that
fixes it, or add a patch Changeset that rebuilds on the current base image.

## Main branch

Every push to `main` publishes the development image. When the `package.json`
version has no matching tag, the same run also publishes the release; see
[Release](RELEASE.md).
