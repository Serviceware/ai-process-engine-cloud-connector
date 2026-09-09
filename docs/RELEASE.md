# Release

Releases are created from semantic version tags.

## Before tagging

1. Update CHANGELOG.md.
2. Update the image version in the maintained Docker Compose examples.
3. Note any required configuration change.
4. Run the checks:

```bash
deno task ci
docker build -t cloud-connector:release-check .
docker compose -f templates/starter/docker-compose.yml config
docker compose -f templates/examples/ticketing-yaml/docker-compose.yml config
```

## Publish

Create and push the matching version tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The release workflow builds and publishes the versioned container image. Promote
the moving latest tag only after the release has been approved.
