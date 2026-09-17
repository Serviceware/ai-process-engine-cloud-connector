# Repository instructions

These instructions apply to the entire repository.

Before changing the repository, read the conventions below. They are part of the
repository contract and must stay aligned with the implementation:

- [Architecture](docs/conventions/ARCHITECTURE.md)
- [Configuration](docs/conventions/CONFIGURATION.md)
- [Security](docs/conventions/SECURITY.md)
- [Development](docs/conventions/DEVELOPMENT.md)
- [Testing](docs/conventions/TESTING.md)
- [Documentation](docs/conventions/DOCUMENTATION.md)
- [Pull requests](docs/conventions/PULL_REQUESTS.md)

Keep the Cloud Connector focused on its forward-proxy role. Prefer small,
explicit changes, preserve deny-by-default behavior, and update tests and
documentation together with behavior.

Before finishing a change, run the checks required by the linked conventions and
inspect the complete diff for generated files, credentials, and unrelated edits.
