# Documentation conventions

Write documentation in concise English and address the reader directly. Lead
with the task an operator or contributor needs to complete, then explain
advanced behavior. Prefer exact commands, file names, defaults, and observable
outcomes over broad descriptions.

## Document ownership

- `README.md` is the fast path: product purpose, Getting started, complete
  deployment inputs, operational behavior, and links to detailed guides.
- `docs/INSTALLATION.md` contains expanded setup and troubleshooting.
- `docs/CI.md` and `docs/RELEASE.md` describe repository automation.
- `docs/conventions/` contains durable maintainer and agent decisions.
- `templates/` contains runnable operator examples.
- `schemas/cloud-connector.schema.json` is the machine-readable YAML contract.

Avoid copying the same detailed explanation into several files. Keep the README
scannable and link to the authoritative detailed document.

## Examples

Examples must be safe to copy:

- use obvious placeholder hosts and credentials;
- never include real secrets;
- pin production images to a complete semantic version;
- keep Compose examples self-contained without sample environment files;
- use the current `docker compose` command spelling; and
- prefer deny-by-default target expressions over broad wildcards.

The release tooling updates complete semantic image references in Markdown and
Compose files. Each file that contains the release image must contain exactly
one versioned reference.

Update documentation in the same pull request as the behavior it describes.
Check relative links, code examples, variable names, defaults, and paths against
the implementation before completion.
