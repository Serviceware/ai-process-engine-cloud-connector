# Release

Node.js scripts manage Serviceware AI Process Engine - Cloud Connector
Changesets, versions, changelog entries, Git tags, and GitHub Releases. The
container is published from an immutable semantic version tag. `package.json`
holds the version and the pnpm scripts.

## Add release intent

Every pull request includes a Changeset:

```bash
pnpm run changeset
```

Choose the Semantic Versioning impact and describe the user-visible change. Use
`pnpm run changeset --empty` when a pull request should not produce a
release. Dependabot pull requests need a Changeset only when they change the
published image; see [Repository checks](CI.md#dependabot).
Do not manually edit the version, generated release heading, or maintained
Compose image tags.

Run the checks before merging:

```bash
pnpm run ci
docker build -t cloud-connector:release-check .
docker compose -f templates/starter/docker-compose.yml config
docker compose -f templates/examples/ticketing-yaml/docker-compose.yml config
```

## Publish

1. An authorized maintainer starts the **Release pull request** workflow on
   `main`. It combines all pending release Changesets, updates `package.json`
   and `CHANGELOG.md`, synchronizes the image version in the maintained Compose
   examples, and creates or updates the release pull request. Without a pending
   release Changeset it creates no pull request; empty Changesets stay until the
   next release consumes them.
2. Approve the pending CI run of the release pull request, review it, and merge
   it, or enable auto-merge.
3. CI on `main` runs the
   [end-to-end tests](CI.md#end-to-end-tests) and then publishes the release
   because the `package.json` version has no `vX.Y.Z` tag yet.

The release run builds the image once for Linux AMD64 and ARM64 and pushes it as
`X.Y.Z`, `X.Y`, `X`, `latest`, `dev`, and `sha-<full-commit-sha>`. It attaches
SBOM and provenance data, checks that all tags resolve to the same multi-platform
image, pulls it with the workflow's GHCR credentials, and smoke-tests the
published digest. Only then does it create the `vX.Y.Z` tag and the GitHub
Release. If that last job fails, rerun it; the published tags stay unchanged.
The image is available only to accounts with package read access; no anonymous
pull is supported.

The repository setting **Actions > General > Allow GitHub Actions to create and
approve pull requests** must be enabled. The first workflow publication creates
and links the private `cloud-connector` package through `GITHUB_TOKEN` and its
OCI source label. The linked repository needs package access for the workflow's
authenticated verification.

## Development images

Every successful push to `main` publishes the same commit for Linux AMD64 and
ARM64 under the moving `dev` tag and the immutable `sha-<full-commit-sha>` tag.
The workflow pulls the commit tag with its GHCR token. Build provenance is
stored in GitHub's attestation service without publishing a non-pullable
`sha256-*` registry tag. Older `sha256-*` package entries are attestations, not
images. Use these tags for integration testing only; production deployments
should stay on a complete semantic version.
