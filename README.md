# Serviceware Cloud Connector

The Serviceware Cloud Connector is a small forward proxy that connects
Serviceware Cloud to explicitly allowed internal HTTP services. It receives
requests from Serviceware Cloud over an outbound WebSocket connection, applies
the configured forwarding rules, and returns the target response.

## Getting started

### Prerequisites

You need:

- Docker Engine with Docker Compose;
- network access from the Docker host to Serviceware Cloud and the internal
  target services;
- a Cloud Connector entry in Serviceware Configuration Store; and
- an OAuth service account with the **Advanced Cloud Connector** permission.

### 1. Copy the starter

```bash
cp -R templates/starter my-cloud-connector
cd my-cloud-connector
```

The starter contains everything needed to run the connector:

| Setting                      | Value                                 |
| ---------------------------- | ------------------------------------- |
| Compose service              | `cloud-connector`                     |
| Container name               | `serviceware-cloud-connector`         |
| Image repository             | `ghcr.io/serviceware/cloud-connector` |
| Configuration file           | `config/cloud-connector.yml`          |
| Container configuration path | `/config/cloud-connector.yml`         |
| Health port                  | `8080`                                |

### 2. Enter the connection values

Open `docker-compose.yml` and replace the three required placeholder values:

| Variable                        | Required | Description                                     |
| ------------------------------- | -------- | ----------------------------------------------- |
| `CLOUD_CONNECTOR_HOST`          | Yes      | Base URL of the Serviceware Cloud environment.  |
| `CLOUD_CONNECTOR_CLIENT_ID`     | Yes      | OAuth client ID provided for the connector.     |
| `CLOUD_CONNECTOR_CLIENT_SECRET` | Yes      | OAuth client secret provided for the connector. |

Target credentials referenced by `cloud-connector.yml`, such as
`INTERNAL_API_TOKEN`, also belong in the Compose `environment` section. Never
commit real credentials. For production, use the secret mechanism provided by
your deployment platform.

### 3. Allow the internal targets

Edit `config/cloud-connector.yml`. Every target is denied unless its complete
absolute URL matches at least one forwarding rule:

```yaml
connection:
  purpose: main
  heartbeatIntervalSeconds: 30

logging:
  level: info

forwarding:
  - target: "^https://internal-api[.]example[.]com(?:/.*)?$"
    methods: [GET, POST]
    timeout: 30000
    request:
      auth:
        type: bearer
        token: "{{ env.INTERNAL_API_TOKEN }}"
```

The `connection.purpose` must match the connector in Configuration Store. See
the [configuration schema](schemas/cloud-connector.schema.json) for the complete
YAML contract.

### 4. Start and verify

```bash
docker compose up -d
docker compose logs -f
```

In another terminal, check the local probe endpoints:

```bash
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
```

`/health` reports whether the process is alive. `/ready` succeeds only while the
outbound connection to Serviceware Cloud is open.

For a more detailed setup and troubleshooting guide, see
[Installation](docs/INSTALLATION.md).

## Deployment reference

### Container image

Release images for Linux AMD64 and ARM64 are published publicly to the GitHub
Container Registry:

```bash
docker pull ghcr.io/serviceware/cloud-connector:0.1.0
```

Use the complete `MAJOR.MINOR.PATCH` tag in production. `MAJOR.MINOR` and
`MAJOR` move to the newest compatible release. `latest` changes only after an
explicit promotion. The available versions and digests are listed in the
[Cloud Connector package](https://github.com/orgs/Serviceware/packages/container/package/cloud-connector).

Builds from `main` are also published as `dev` and `sha-<full-commit-sha>` for
integration testing. Do not use these moving or development tags in production.

### Environment variables

The three connection variables listed in Getting started are required. The
following optional variables tune runtime resilience and safety limits. The
built-in defaults suit most installations.

| Variable                                    |    Default | Purpose                                                           |
| ------------------------------------------- | ---------: | ----------------------------------------------------------------- |
| `CLOUD_CONNECTOR_RECONNECT_INITIAL_SECONDS` |        `1` | Initial reconnect delay.                                          |
| `CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS`     |       `30` | Maximum reconnect delay.                                          |
| `CLOUD_CONNECTOR_CONNECT_TIMEOUT_SECONDS`   |       `10` | Timeout for opening the cloud connection.                         |
| `CLOUD_CONNECTOR_RECONNECT_STABLE_SECONDS`  |        `5` | Open time after which reconnect backoff resets.                   |
| `CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR`  |        `3` | Missed-heartbeat tolerance; `0` disables this timeout.            |
| `CLOUD_CONNECTOR_TOKEN_TIMEOUT_SECONDS`     |       `10` | Timeout for OAuth token requests.                                 |
| `CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO`    |      `0.5` | Reconnect jitter from `0` to `1`.                                 |
| `CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS`    |      `120` | Maximum age of the runtime supervision tick.                      |
| `CLOUD_CONNECTOR_MAX_RESPONSE_BODY_BYTES`   | `10485760` | Maximum buffered target response size.                            |
| `CLOUD_CONNECTOR_MAX_CONCURRENT_REQUESTS`   |      `100` | Maximum forwarded requests in flight.                             |
| `CLOUD_CONNECTOR_DRAIN_TIMEOUT_SECONDS`     |       `30` | Time allowed for requests to finish during reconnect or shutdown. |

All durations must be whole seconds. The liveness window must be greater than
the maximum reconnect delay and the configured heartbeat timeout.

### Volume and port

| Host path  | Container path | Mode      | Required | Purpose                                                  |
| ---------- | -------------- | --------- | -------- | -------------------------------------------------------- |
| `./config` | `/config`      | Read-only | Yes      | Provides `cloud-connector.yml` and supports hot reloads. |

Mount the directory, not only the file, so atomic file replacements and
projected-volume updates can be detected. The connector listens on port `8080`
for `/health` and `/ready`. Publishing that port is useful for host-based
monitoring but is not required for the outbound cloud connection.

## Configuration behavior

`config/cloud-connector.yml` is watched while the connector runs. A valid change
updates logging and forwarding immediately; a connection change causes a
controlled reconnect. Invalid changes are rejected and the last working
configuration stays active.

Forwarding rules are evaluated in order. Later matching rules override earlier
explicit methods, headers, timeouts, and authentication. No matching rule means
deny. Inbound `authorization`, `cookie`, and `proxy-authorization` headers are
removed unless a rule explicitly enables `forwardIncomingCredentials`.

Basic authentication, static Bearer tokens, and OAuth 2.0 client credentials are
supported for targets. Secret values can be interpolated with `{{ env.NAME }}`.
Responses are buffered as UTF-8 text; binary response bodies are not supported
by the current cloud protocol.

## Development

Use the Deno version from `.dvmrc`, then run the complete local check suite:

```bash
deno task ci
```

See [Contributing](CONTRIBUTING.md) for the contribution workflow and
[Repository checks](docs/CI.md) for CI details.
