# Pull request conventions

Create focused branches from the current `main` branch. Keep commits reviewable
and use an imperative Conventional Commit-style subject such as `docs:`, `fix:`,
`feat:`, or `refactor:`.

Every pull request must add a Changeset:

```bash
deno task changeset
```

Use `patch`, `minor`, or `major` for a user-visible release change. Use an empty
Changeset for documentation, tests, or internal tooling that should not change
the released version:

```bash
deno task changeset --empty
```

Do not edit the package version, changelog release heading, Git tags, or
maintained image tags manually. The release workflow consumes Changesets and
updates those artifacts.

Before opening or updating a pull request:

1. Rebase or merge the latest `main` as appropriate for the team workflow.
2. Run the verification required by [Testing](TESTING.md).
3. Review the complete diff for secrets, unrelated edits, and generated-file
   drift.
4. Summarize the user impact and the checks performed.
5. Call out security-sensitive changes, compatibility changes, and any follow-up
   work explicitly.

Keep the pull request green. Address review findings with additional commits
until the change is ready to merge.
