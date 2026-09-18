# Release

Deno scripts manage Serviceware AI Process Engine - Cloud Connector Changesets,
versions, changelog entries, Git tags, and GitHub Releases. The container is
published from an immutable semantic version tag. Deno is the only required
JavaScript runtime, and `deno.json` is the only package and task manifest.

## Add release intent

Every pull request includes a Changeset:

```bash
deno task changeset
```

Choose the Semantic Versioning impact and describe the user-visible change. Use
`deno task changeset --empty` when a pull request should not produce a release.
Do not manually edit the version, generated release heading, or maintained
Compose image tags.

Run the checks before merging:

```bash
deno task ci
docker build -t cloud-connector:release-check .
docker compose -f templates/starter/docker-compose.yml config
docker compose -f templates/examples/ticketing-yaml/docker-compose.yml config
```

## Publish

An authorized maintainer starts the **Deno release management** workflow
manually. It creates or updates a release pull request that combines all pending
entries, updates `deno.json` and `CHANGELOG.md`, and synchronizes the image
version in both maintained Compose examples.

After merging the release pull request, start the workflow manually again. This
creates `vX.Y.Z` and a GitHub Release. The same workflow invokes the verified
container publisher for `ghcr.io/serviceware/cloud-connector:X.Y.Z` on Linux
AMD64 and ARM64. It also updates the moving `X.Y` and `X` tags, attaches SBOM
and provenance data, checks the published manifest, and proves the package is
anonymously pullable before the release succeeds. A manually pushed semantic
version tag still runs the container release workflow as a recovery path.

The repository setting **Actions > General > Allow GitHub Actions to create and
approve pull requests** must be enabled. The first workflow publication creates
and links the `cloud-connector` package through `GITHUB_TOKEN` and its OCI
source label. If organization policy disables inherited public visibility, an
organization owner must open the package settings once, connect this repository,
and set the package visibility to **Public**; the anonymous-pull verification
will fail until that is done. Promote the moving `latest` tag only after the
release has been approved.

## Development images

Every successful push to `main` publishes the same commit for Linux AMD64 and
ARM64 under the moving `dev` tag and the immutable `sha-<full-commit-sha>` tag.
The workflow verifies that the resulting image is anonymously readable. Use
these tags for integration testing only; production deployments should stay on a
complete semantic version.
