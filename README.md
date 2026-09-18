# Serviceware AI Process Engine - Cloud Connector

The Serviceware AI Process Engine - Cloud Connector is a small forward proxy
that connects Serviceware AI Process Engine to explicitly allowed internal HTTP
services. It receives requests over an outbound WebSocket connection, applies
the configured forwarding rules, and returns the target response.

## Getting started

### Prerequisites

You need:

- Docker Engine;
- network access from the Docker host to Serviceware AI Process Engine and the
  internal target services; and
- an OAuth service account with the **Advanced Cloud Connector** permission.

You do not need to create a connector purpose manually. Serviceware AI Process
Engine creates the configured `connection.purpose` when the connector connects
for the first time.

### 1. Create the configuration volume

Create `config/cloud-connector.yml` in an otherwise empty directory:

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

Every target is denied unless its complete absolute URL matches at least one
forwarding rule. See the
[configuration schema](schemas/cloud-connector.schema.json) for the complete
YAML contract.

### 2. Start the container

Export the three required connection variables and any target secrets, such as
`INTERNAL_API_TOKEN`, into the current shell through your secret-management
tool. Pass only the variable names to Docker so secret values do not appear in
the command:

```bash
docker run --detach \
  --name serviceware-ai-process-engine-cloud-connector \
  --restart unless-stopped \
  --publish 8080:8080 \
  --volume "$PWD/config:/config:ro" \
  --env CLOUD_CONNECTOR_HOST \
  --env CLOUD_CONNECTOR_CLIENT_ID \
  --env CLOUD_CONNECTOR_CLIENT_SECRET \
  --env INTERNAL_API_TOKEN \
  ghcr.io/serviceware/cloud-connector:latest
```

Check the local probe endpoints:

```bash
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
```

`/health` reports whether the process is alive. `/ready` succeeds only while the
outbound connection to Serviceware AI Process Engine is open.

For a production-oriented setup and troubleshooting guide, see
[Installation](docs/INSTALLATION.md).

### Environment variables

The connector reads the following runtime variables. Target secrets referenced
by `cloud-connector.yml` are additional user-defined variables and have no
connector-defined names or defaults.

| Variable                                    | Required |    Default | Purpose                                                           |
| ------------------------------------------- | :------: | ---------: | ----------------------------------------------------------------- |
| `CLOUD_CONNECTOR_HOST`                      |   Yes    |          — | Base URL of the Serviceware AI Process Engine environment.        |
| `CLOUD_CONNECTOR_CLIENT_ID`                 |   Yes    |          — | OAuth client ID provided for the connector.                       |
| `CLOUD_CONNECTOR_CLIENT_SECRET`             |   Yes    |          — | OAuth client secret provided for the connector.                   |
| `CLOUD_CONNECTOR_RECONNECT_INITIAL_SECONDS` |    No    |        `1` | Initial reconnect delay.                                          |
| `CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS`     |    No    |       `30` | Maximum reconnect delay.                                          |
| `CLOUD_CONNECTOR_CONNECT_TIMEOUT_SECONDS`   |    No    |       `10` | Timeout for opening the platform connection.                      |
| `CLOUD_CONNECTOR_RECONNECT_STABLE_SECONDS`  |    No    |        `5` | Open time after which reconnect backoff resets.                   |
| `CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR`  |    No    |        `3` | Missed-heartbeat tolerance; `0` disables this timeout.            |
| `CLOUD_CONNECTOR_TOKEN_TIMEOUT_SECONDS`     |    No    |       `10` | Timeout for OAuth token requests.                                 |
| `CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO`    |    No    |      `0.5` | Reconnect jitter from `0` to `1`.                                 |
| `CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS`    |    No    |      `120` | Maximum age of the runtime supervision tick.                      |
| `CLOUD_CONNECTOR_MAX_RESPONSE_BODY_BYTES`   |    No    | `10485760` | Maximum buffered target response size.                            |
| `CLOUD_CONNECTOR_MAX_CONCURRENT_REQUESTS`   |    No    |      `100` | Maximum forwarded requests in flight.                             |
| `CLOUD_CONNECTOR_DRAIN_TIMEOUT_SECONDS`     |    No    |       `30` | Time allowed for requests to finish during reconnect or shutdown. |

All durations must be whole seconds. The liveness window must be greater than
the maximum reconnect delay and the configured heartbeat timeout.

### Volume

The connector uses one configuration volume:

| Host path  | Container path | Mode      | Required | Purpose                                                  |
| ---------- | -------------- | --------- | :------: | -------------------------------------------------------- |
| `./config` | `/config`      | Read-only |   Yes    | Provides `cloud-connector.yml` and supports hot reloads. |

Mount the directory, not only the file, so atomic file replacements and
projected-volume updates can be detected. The connector listens on port `8080`
for `/health` and `/ready`. Publishing that port is useful for host-based
monitoring but is not required for the outbound platform connection.

### Docker Compose

The [starter](templates/starter) and
[ticketing example](templates/examples/ticketing-yaml) contain Docker Compose
files for local testing and as deployment references. If you replace their
placeholders, the resulting Compose files contain secrets in clear text. Do not
use them as-is in production or commit the populated files.

Use a container orchestrator such as Kubernetes or Nomad for production and
inject credentials from its secret store. If you only want to test locally, copy
a template, replace its placeholders, and run `docker compose up -d`.

## Container image

Release images for Linux AMD64 and ARM64 are published publicly to the
[container package](https://github.com/orgs/Serviceware/packages/container/package/cloud-connector).
The `latest` tag points to the most recently promoted release. For repeatable
production rollouts, deploy the image digest that you validated.

Builds from `main` are also published as `dev` and `sha-<full-commit-sha>` for
integration testing. Do not use these development tags in production.

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
by the current platform protocol.

## Development

Install [Deno Version Manager (`dvm`)](https://github.com/justjavac/dvm) if it
is not already available. It installs Deno without requiring a pre-existing Deno
installation:

```bash
# macOS, Linux, or WSL
curl -fsSL https://raw.githubusercontent.com/justjavac/dvm/main/install.sh | sh
```

On Windows, run the installer in PowerShell instead:

```powershell
irm https://raw.githubusercontent.com/justjavac/dvm/main/install.ps1 | iex
```

Open a new shell, then install and select the Deno version from `.dvmrc` before
running the complete local check suite:

```bash
dvm install
dvm use
deno task ci
```

See [Contributing](CONTRIBUTING.md) for the contribution workflow and
[Repository checks](docs/CI.md) for CI details.
