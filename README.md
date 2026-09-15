# Serviceware Cloud Connector

The Cloud Connector links Serviceware Cloud to explicitly allowed internal HTTP
services. It receives calls from the cloud, forwards them according to ordered
target rules, and returns the response.

It is intentionally limited to this proxy role. It does not run customer code or
provide a local WebSocket endpoint.

## Configuration

There are two configuration sources:

- config/cloud-connector.yml contains the heartbeat, log level, and ordered
  forwarding rules.
- .env contains the Serviceware host and credentials. Secrets used for target
  authentication also stay there.

The YAML file is the single place for day-to-day operating changes:

```yaml
connection:
  purpose: main
  heartbeatIntervalSeconds: 30

logging:
  level: info

forwarding:
  - target: "^https://internal-api[.]example[.]com(?:/|$)"
    methods: [GET, POST]
    timeout: 30000
    request:
      auth:
        type: bearer
        token: "{{ env.INTERNAL_API_TOKEN }}"
```

Changes to this file are checked and applied while the connector is running. If
a change is invalid, the previous working configuration remains active. The
WebSocket URL is derived from `CLOUD_CONNECTOR_HOST` and the connection
`purpose`, which defaults to `main`. Connection changes cause a reconnect;
forwarding or logging changes apply to the next call.

Each forwarding `target` is a regular expression matched against the complete
absolute request URL. All matching rules are merged in order; later explicit
`methods`, header entries, authentication, and `timeout` values win. A request
that matches no rule is denied. An empty `methods: []` deliberately denies all
methods until a later, more specific rule enables them.

Request authentication supports Basic credentials, static Bearer tokens, and
OAuth 2.0 client credentials. Secrets can be interpolated from the environment
with `{{ env.NAME }}` or `{{env:NAME}}`; for OAuth 2.0, `issuer` identifies the
token endpoint and tokens are cached until shortly before expiry.

Most installations can use the default resilience settings. If tuning is needed,
those values remain environment variables.

## Start

```bash
cp -R templates/starter my-cloud-connector
cd my-cloud-connector
cp .env.example .env
# Edit .env and config/cloud-connector.yml
docker compose up -d
```

Check the connector with:

```bash
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
```

For setup help, see [Installation](docs/INSTALLATION.md). The complete YAML
contract is available in
[cloud-connector.schema.json](schemas/cloud-connector.schema.json).

## Development

Use the Deno version from `.dvmrc`, then run all checks:

```bash
deno task ci
```

See [Contributing](CONTRIBUTING.md) for the short contribution workflow.
