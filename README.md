# Cloud Connector

The Cloud Connector connects internal HTTP services to the Serviceware Cloud
over an authenticated WebSocket connection. Workload requests are forwarded to
one target configured in YAML and are default-deny at the network boundary.

## Security and customization model

The runtime accepts exactly one declarative YAML forwarding configuration. It
does not load or execute customer TypeScript, JavaScript, Python, or other
scripts. There is no customer SDK, module loader, file-based route registry, or
transparent proxy mode.

Two independent controls must permit workload traffic:

1. `forwarding.yml` selects the one target base URL.
2. `OUTBOUND_URL_ALLOWLIST` must match the normalized absolute URL of every
   initial request and redirect.

An absent allowlist and `OUTBOUND_URL_ALLOWLIST=[]` deny all workload URLs.
`OUTBOUND_URL_ALLOWLIST=[".*"]` explicitly permits every URL and should only be
used after a security review. The required Serviceware Cloud OAuth and WebSocket
control-plane requests are not workload traffic and do not use this allowlist.

## Quick start

Copy the starter template and configure it:

```bash
cp -R templates/starter my-cloud-connector
cd my-cloud-connector
cp .env.example .env
docker compose up -d
```

The container requires a readable YAML file. The starter mounts it at
`/config/forwarding.yml` and sets:

```env
CLOUD_CONNECTOR_FORWARDING_CONFIG=/config/forwarding.yml
```

Configuration is loaded and validated before the HTTP server or cloud connection
starts. A missing, malformed, or unsupported configuration causes a startup
failure. Restart the container after changing the file.

## Forwarding configuration

```yaml
# yaml-language-server: $schema=./schemas/forwarding.schema.json
target: "{{ env.INTERNAL_API_URL }}"
methods: [GET, POST, PUT, PATCH, DELETE]
timeout: 30000

request:
  headers:
    set:
      authorization: "Bearer {{ env.INTERNAL_API_TOKEN }}"
    add:
      x-request-id: "{{ context.requestId }}"
    remove:
      - x-forwarded-for
  pathPrefix: /api/v2

response:
  headers:
    remove:
      - server
      - x-powered-by
```

Every inbound path and query string is forwarded to `target`. An absolute URL
received from the cloud cannot override the configured target origin; only its
path and query are retained. The target must use HTTP or HTTPS and every final
URL must match the outbound allowlist.

Supported top-level properties:

| Property   | Required | Meaning                                                            |
| ---------- | -------- | ------------------------------------------------------------------ |
| `target`   | yes      | Absolute HTTP(S) base URL; environment interpolation is supported  |
| `methods`  | no       | Enabled uppercase HTTP methods; all supported methods when omitted |
| `timeout`  | no       | Upstream timeout from 1,000 to 300,000 ms; default 30,000 ms       |
| `request`  | no       | Request headers and one static path prefix                         |
| `response` | no       | Response headers                                                   |

Header configuration supports `set`, `add`, and `remove`. `pathPrefix` is the
only path adjustment and must be a static absolute path. See
[`schemas/forwarding.schema.json`](schemas/forwarding.schema.json) for the
complete machine-readable contract.

Available interpolation values:

| Value                                                                          | Meaning                     |
| ------------------------------------------------------------------------------ | --------------------------- |
| `{{ env.NAME }}`                                                               | Environment variable        |
| `{{ context.requestId }}`                                                      | Workload request identifier |
| `{{ context.startedAt }}`                                                      | Request start timestamp     |
| Interpolation is string substitution only. It does not evaluate expressions or |                             |
| execute code.                                                                  |                             |

The configuration deliberately does not support conditions, request or response
body replacement, response status replacement, arbitrary URL rewrites, suffixes,
prefix removal, multiple targets, or target selection from inbound request
values.

## Outbound URL allowlist

The variable contains a JSON array of JavaScript-compatible regular expressions.
Expressions are matched against the normalized absolute URL. Prefer anchored
expressions with a host boundary:

```env
# One HTTPS host, all paths
OUTBOUND_URL_ALLOWLIST=["^https://api[.]example[.]com(?:/|$)"]

# One internal host and optional port
OUTBOUND_URL_ALLOWLIST=["^http://internal-api(?::3000)?(?:/|$)"]

# Explicit unrestricted configuration
OUTBOUND_URL_ALLOWLIST=[".*"]
```

Invalid JSON or regular expressions fail startup. Redirects are followed only
when their destination also matches. Cross-origin redirects lose authorization,
cookie, and proxy-authorization credentials.

## Environment variables

| Variable                                     | Default          | Description                                    |
| -------------------------------------------- | ---------------- | ---------------------------------------------- |
| `CLOUD_CONNECTOR_HOST`                       | —                | Serviceware Cloud HTTP base URL for OAuth      |
| `CLOUD_CONNECTOR_WS_URL`                     | —                | Serviceware Cloud WebSocket URL                |
| `CLOUD_CONNECTOR_CLIENT_ID`                  | —                | OAuth client ID                                |
| `CLOUD_CONNECTOR_CLIENT_SECRET`              | —                | OAuth client secret                            |
| `CLOUD_CONNECTOR_FORWARDING_CONFIG`          | `forwarding.yml` | Required YAML configuration path               |
| `OUTBOUND_URL_ALLOWLIST`                     | `[]`             | Workload URL regex allowlist                   |
| `CLOUD_CONNECTOR_LOG_LEVEL`                  | `info`           | `error`, `warn`, `info`, or `debug`            |
| `CONNECTOR_HOST`                             | `0.0.0.0`        | Local health/WebSocket server bind address     |
| `CONNECTOR_PORT`                             | `8080`           | Local health/WebSocket server port             |
| `CLOUD_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS` | `30`             | Heartbeat interval                             |
| `CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR`   | `3`              | Dead-peer interval factor; `0` disables it     |
| `CLOUD_CONNECTOR_CONNECT_TIMEOUT_SECONDS`    | `10`             | WebSocket open timeout                         |
| `CLOUD_CONNECTOR_RECONNECT_INITIAL_SECONDS`  | `1`              | Initial reconnect delay                        |
| `CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS`      | `30`             | Maximum reconnect delay                        |
| `CLOUD_CONNECTOR_RECONNECT_STABLE_SECONDS`   | `5`              | Stable-open threshold before resetting backoff |
| `CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO`     | `0.5`            | Reconnect jitter from `0` to `1`               |
| `CLOUD_CONNECTOR_TOKEN_TIMEOUT_SECONDS`      | `10`             | OAuth request timeout                          |
| `CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS`     | `120`            | Supervision-loop liveness window               |

Cloud authentication is optional only for local runtime tests. When any cloud
connection setting is used, all four cloud authentication settings are required.

## Operations

The local HTTP endpoints are:

| Endpoint  | Result                                                                     |
| --------- | -------------------------------------------------------------------------- |
| `/health` | Process liveness; 503 only when the supervision loop is stale              |
| `/ready`  | 200 when the cloud WebSocket is usable, or when no WebSocket is configured |
| `/ws`     | WebSocket upgrade endpoint                                                 |

The runtime returns stable error codes to the cloud, including:

| Code                       | Meaning                                     |
| -------------------------- | ------------------------------------------- |
| `CONFIG_ERROR`             | Missing or invalid forwarding configuration |
| `YAML_PARSE_ERROR`         | Malformed YAML                              |
| `METHOD_NOT_ALLOWED`       | HTTP method disabled by YAML                |
| `OUTBOUND_URL_NOT_ALLOWED` | Target or redirect denied by the allowlist  |
| `TIMEOUT`                  | Forwarding timeout                          |
| `TARGET_REQUEST_ERROR`     | Upstream request failure                    |

## Development

Use Deno 2.8.1 or newer:

```bash
deno task check
deno task lint
deno task test
```

The runtime OpenAPI models are generated with `deno task generate:api`. The
repository intentionally contains no customer scripting package or executable
customization examples.

## Repository layout

```text
.
├── runtime/                    # Connector runtime and tests
├── schemas/forwarding.schema.json
├── templates/starter/         # Minimal YAML-only deployment
├── templates/examples/ticketing-yaml/
├── openapi/api.yml            # Cloud wire protocol
├── Dockerfile
└── docs/
```

See [`docs/INSTALLATION.md`](docs/INSTALLATION.md) for deployment details and
[`docs/RELEASE.md`](docs/RELEASE.md) for the release checklist.
