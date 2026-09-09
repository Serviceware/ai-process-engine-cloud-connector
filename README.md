# Serviceware Cloud Connector

The Cloud Connector links Serviceware Cloud to one internal HTTP service. It
receives calls from the cloud, forwards them to the configured service, and
returns the response.

It is intentionally limited to this proxy role. It does not run customer code,
manage several targets, or provide a local WebSocket endpoint.

## Configuration

There are two configuration sources:

- config/cloud-connector.yml contains the connection, heartbeat, log level, and
  forwarding settings.
- .env contains the Serviceware host and credentials. Secrets used for target
  authentication also stay there.

The YAML file is the single place for day-to-day operating changes:

```yaml
connection:
  websocketUrl: wss://cloud.example.com/connector/ws
  heartbeatIntervalSeconds: 30

logging:
  level: info

forwarding:
  target: https://internal-api.example.com
  outboundUrlAllowlist:
    - "^https://internal-api[.]example[.]com(?:/|$)"
  timeout: 30000
  request:
    headers:
      set:
        authorization: "Bearer {{ env.INTERNAL_API_TOKEN }}"
```

Changes to this file are checked and applied while the connector is running. If
a change is invalid, the previous working configuration remains active.
Connection changes cause a reconnect; other changes apply to the next call.

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

Use the Deno version from .dvmrc and run:

```bash
deno task ci
```

See [Contributing](CONTRIBUTING.md) for the short contribution workflow.
