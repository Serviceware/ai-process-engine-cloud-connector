# Release

Changesets manages Cloud Connector versions, changelog entries, Git tags, and
GitHub Releases. The container continues to be published from an immutable
semantic version tag.

## Add release intent

Every pull request includes a Changeset:

```bash
npm ci
npm run changeset
```

Choose the Semantic Versioning impact and describe the user-visible change. Use
`npm run changeset -- --empty` when a pull request should not produce a release.
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

After changesets reach `main`, the Changesets workflow creates or updates a
release pull request. It combines all pending entries, updates `package.json`
and `CHANGELOG.md`, and synchronizes the image version in both maintained
Compose examples.

Merging the release pull request creates `vX.Y.Z` and a GitHub Release. The same
workflow invokes the verified container publisher for
`ghcr.io/serviceware/cloud-connector:X.Y.Z` and the matching major tag. A
manually pushed semantic version tag still runs the container release workflow
as a recovery path.

The repository setting **Actions > General > Allow GitHub Actions to create and
approve pull requests** must be enabled. Promote the moving `latest` tag only
after the release has been approved.
