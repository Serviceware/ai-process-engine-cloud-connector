# Configuration conventions

## Configuration sources

Use environment variables for process credentials, target secrets, and
resilience limits. Use `cloud-connector.yml` for settings that operators may
hot-reload: connection purpose, heartbeat interval, log level, and forwarding
rules.

The production container reads `/config/cloud-connector.yml`. Maintained Compose
files mount `./config` to `/config` as read-only. Keep examples self-contained
in their Compose and YAML files; do not add separate sample environment files.

## Environment variables

`CLOUD_CONNECTOR_HOST`, `CLOUD_CONNECTOR_CLIENT_ID`, and
`CLOUD_CONNECTOR_CLIENT_SECRET` are required. Optional runtime variables must
have safe defaults in `runtime/config.ts`, strict validation, tests, and an
entry in the root README.

Do not introduce aliases for the same runtime setting. Name new variables with
the `CLOUD_CONNECTOR_` prefix and include the unit in time- or size-related
names.

## YAML contract

Reject unknown fields and invalid values instead of silently coercing them. When
the YAML contract changes, update all of the following in the same change:

- runtime types and validation in `runtime/config.ts`;
- `schemas/cloud-connector.schema.json`;
- focused configuration and forwarding tests;
- maintained examples; and
- operator documentation.

Target expressions match the complete absolute HTTP or HTTPS URL. They must be
anchored with `^` and `$` and must pass the safe-regex checks. A non-matching
request is denied.

## Rule merging

Evaluate matching forwarding rules in declaration order. Later explicit scalar
values, method lists, header entries, and timeouts override earlier values.
Header additions accumulate. Authentication belongs only to the last matching
rule so credentials do not leak from a broader rule into a narrower one.

An omitted method list means all supported methods. An explicit empty list
denies all methods until a later matching rule replaces it. Preserve these
distinctions in parsing and merging logic.

## Secrets

YAML may refer to environment secrets as `{{ env.NAME }}` or `{{env:NAME}}`.
Never put real secrets in source, fixtures, examples, logs, or error messages.
Use obvious placeholders in documentation and Compose files.
