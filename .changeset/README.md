# Changesets

Every pull request must include either a release changeset or an empty
changeset.

Create a release changeset interactively:

```bash
npm run changeset
```

Choose `patch`, `minor`, or `major` according to Semantic Versioning and write a
short, user-facing summary. If a pull request only changes tests, documentation,
or internal tooling and must not produce a release, create an empty changeset:

```bash
npm run changeset -- --empty
```

The repository's release script consumes these files. Do not edit the version
in `package.json`, release headings in `CHANGELOG.md`, or maintained
Compose image tags by hand.
