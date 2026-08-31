# Ticketing integration with YAML forwarding

This example forwards every workload request to one ticketing API using the
single `forwarding.yml` file. It contains no TypeScript, JavaScript, SDK, route
files, or executable customer customization.

The supplied configuration:

- forwards to `TICKET_API_URL`;
- prefixes inbound paths with `/api/v2`;
- injects the ticketing API token and request metadata;
- removes selected internal request and response headers; and
- times out upstream calls after 30 seconds.

`OUTBOUND_URL_ALLOWLIST` permits only the example target. Redirect destinations
are checked against the same allowlist.

## Start

```bash
cp .env.example .env
docker compose up -d
curl --fail http://localhost:8080/health
```

Edit `forwarding.yml` for declarative forwarding changes and restart the
container afterwards. The schema is available at
`schemas/forwarding.schema.json`.
