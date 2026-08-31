# Cloud Connector

The Cloud Connector is a Deno process that runs in the customer network (DMZ).
It establishes an outbound WebSocket connection to the Serviceware Cloud,
enabling secure communication between the cloud and the customer's internal
systems.

> **📖 For Customers:** See the [Installation Guide](docs/INSTALLATION.md) for
> step-by-step instructions.

> **Release information:** See the [changelog](CHANGELOG.md). Maintainers can
> use the [release guide](docs/RELEASE.md).

> **Protocol roadmap:** The Cloud Connector is HTTP-only today. See
> [Future Protocol Families](docs/FUTURE_PROTOCOLS.md) for the extension points
> required before IMAP or SMTP support is implemented.

## HTTP Function Runtime

The Cloud Connector runs function-based endpoints from a `functions/` directory.
Functions can be implemented in TypeScript for custom logic or YAML for
declarative proxy scenarios.

Functions are **opt-in**. If the functions directory is missing or empty, the
Cloud Connector automatically runs in **proxy mode**: it forwards each incoming
request 1:1 to the absolute target URL the request carries and returns the
upstream response. No route configuration is required, but every target must be
explicitly permitted by `OUTBOUND_URL_ALLOWLIST`.

The runtime watches the functions directory. When files are added, changed, or
removed, routes are recomposed in-process and the active routing mode switches
between HTTP function mode and HTTP proxy mode as needed. The complete route
table is logged at startup and after every reload.

---

## HTTP Function Mode (recommended)

In HTTP Function Mode, you define API endpoints as TypeScript files in a
`functions/` directory. The file structure directly corresponds to URL paths.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Serviceware Cloud                         │
│                                                                  │
│   ┌──────────────┐         WebSocket          ┌──────────────┐  │
│   │  Cloud API   │◄──────────────────────────►│   Gateway    │  │
│   └──────────────┘                            └──────────────┘  │
│                                                       ▲         │
└───────────────────────────────────────────────────────│─────────┘
                                                        │
                                                        │ Outbound
                                                        │ WebSocket
                                                        │
┌───────────────────────────────────────────────────────│─────────┐
│                      Customer Network (DMZ)           │         │
│                                                       ▼         │
│   ┌───────────────────────────────────────────────────────────┐ │
│   │                    Cloud Connector                       │ │
│   │                    (Function Mode)                        │ │
│   │                                                           │ │
│   │   functions/                                              │ │
│   │   ├── health.ts           → GET /health                   │ │
│   │   ├── users/                                              │ │
│   │   │   ├── index.ts        → GET/POST /users               │ │
│   │   │   └── [id].ts         → GET/PUT/DELETE /users/:id     │ │
│   │   └── proxy/                                              │ │
│   │       └── [...path].ts    → ANY /proxy/*                  │ │
│   │                                                           │ │
│   └───────────────────────────────────────────────────────────┘ │
│                               │                                  │
│                               ▼                                  │
│                    ┌──────────────────┐                          │
│                    │   Internal APIs  │                          │
│                    │  (ERP, AD, etc.) │                          │
│                    └──────────────────┘                          │
└──────────────────────────────────────────────────────────────────┘
```

### Quick Start

```bash
# 1. Copy starter template
cp -r cloud-connector/templates/starter my-cloud-connector
cd my-cloud-connector

# 2. Configure settings
cp .env.example .env
nano .env

# 3. Start with Docker
docker-compose up -d
```

### Function Structure

Each function exports an HTTP route definition. Use `defineHttp` for a compact
functional style or `http()` for a fluent style:

```typescript
// functions/users/index.ts
import { defineHttp } from "@serviceware/cloud-connector-sdk";

export default defineHttp({
  get: (ctx) => {
    const department = ctx.req.query.get("department");
        // ... fetch data ...
    return ctx.res.ok().json({ users: [...] });
    },

  post: async (ctx) => {
    const body = await ctx.req.body.json<{ name: string }>();
        // ... create user ...
    return ctx.res.created().json({ created: true });
    },
});
```

### URL Parameters

| File                           | URL Pattern  | Example                     |
| ------------------------------ | ------------ | --------------------------- |
| `functions/index.ts`           | `/*`         | `GET /any/path`             |
| `functions/health.ts`          | `/health`    | `GET /health`               |
| `functions/users/index.ts`     | `/users`     | `GET /users`, `POST /users` |
| `functions/users/[id].ts`      | `/users/:id` | `GET /users/123`            |
| `functions/files/[...path].ts` | `/files/*`   | `GET /files/a/b/c.txt`      |

Place `index.ts`, `index.yml`, or `index.yaml` directly inside `functions/` to
register a root catch-all handler. More specific route files are still matched
before the root handler.

### Handler Context

```typescript
ctx.requestId; // Request UUID
ctx.startedAt; // ISO 8601 timestamp
ctx.req.method; // HTTP method
ctx.req.url; // URL object
ctx.req.params.get("id"); // URL parameters
ctx.req.query.get("department"); // URLSearchParams
ctx.req.headers; // Request headers
ctx.env; // Environment variables
ctx.req.raw; // Original Request object
ctx.res; // Response factory

// Read body
await ctx.req.body.json<T>(); // JSON
await ctx.req.body.text(); // Text
await ctx.req.body.formData(); // FormData

// Responses
ctx.res.ok().json(data); // JSON response
ctx.res.created().json(data);
ctx.res.ok().text("Hello"); // Text response
ctx.res.noContent(); // 204 No Content
ctx.res.notFound("Not found");
```

### Docker Deployment (Function Mode)

```bash
docker run -d \
  -p 8080:8080 \
  -e CLOUD_CONNECTOR_WS_URL=wss://cloud.serviceware.se/connector/ws \
  -e CLOUD_CONNECTOR_HOST=https://dev.ai-process-engine.labs.swops.cloud \
  -e CLOUD_CONNECTOR_CLIENT_ID=your-client-id \
  -e CLOUD_CONNECTOR_CLIENT_SECRET=your-client-secret \
  -e CLOUD_CONNECTOR_FUNCTIONS_DIR=/functions \
  -e OUTBOUND_URL_ALLOWLIST='[]' \
  -v /path/to/functions:/functions:ro \
  ghcr.io/serviceware/cloud-connector:3.0.0
```

---

## YAML Functions (declarative)

For simple proxy scenarios, you can use **YAML Functions** - declarative proxy
definitions without TypeScript.

### Example

```yaml
# functions/tickets/index.yml
# Route: /tickets (all methods)

target: "{{ env.TICKET_API_URL }}"

request:
  headers:
    set:
      authorization: "Bearer {{ env.TICKET_API_TOKEN }}"
  url:
    prefix: "/api/v2"

response:
  headers:
    remove:
      - x-internal-debug
```

### YAML Function Format

```yaml
# Target URL (required)
target: "{{ env.API_URL }}"

# Optional: Allowed methods (default: all)
methods: [GET, POST]

# Optional: Timeout in ms (default: 30000)
timeout: 30000

# Request transformations
request:
  headers:
    set: { ... }
    add: { ... }
    remove: [...]
  url:
    prefix: "/api"
    removePrefix: "/external"
    rewrite: "/new/path"

# Response transformations
response:
  headers:
    set: { ... }
    add: { ... }
    remove: [...]
  statusCode:
    set: 200
```

### When to use YAML vs TypeScript?

| Scenario                      | YAML Function | TypeScript Function |
| ----------------------------- | ------------- | ------------------- |
| Simple proxy with auth        | ✅            | ○                   |
| Transform headers/URL         | ✅            | ✅                  |
| Complex business logic        | ❌            | ✅                  |
| Load data from DB/cache       | ❌            | ✅                  |
| Multiple backend calls        | ❌            | ✅                  |
| Manipulate response body JSON | ❌            | ✅                  |

### Schema Validation (VS Code)

For autocompletion and validation in VS Code:

**Option 1: Schema comment in the YAML file**

```yaml
# yaml-language-server: $schema=../../schemas/yaml-function.schema.json
target: "{{ env.API_URL }}"
```

**Option 2: VS Code Workspace Settings**

```json
// .vscode/settings.json
{
  "yaml.schemas": {
    "./schemas/yaml-function.schema.json": [
      "**/functions/**/*.yml",
      "**/functions/**/*.yaml"
    ]
  }
}
```

The schema is located at
[`schemas/yaml-function.schema.json`](schemas/yaml-function.schema.json).

---

## YAML Function Transform Details

### Template Variables

The following variables can be used in YAML function transformations:

| Variable                  | Description          | Example                |
| ------------------------- | -------------------- | ---------------------- |
| `{{ env.VARIABLE }}`      | Environment variable | `{{ env.API_TOKEN }}`  |
| `{{ context.requestId }}` | Unique request ID    | `550e8400-e29b-...`    |
| `{{ context.startedAt }}` | Timestamp (ISO 8601) | `2024-01-15T10:30:00Z` |
| `{{ request.url }}`       | Request URL          | `/api/users`           |
| `{{ request.method }}`    | HTTP method          | `GET`                  |
| `{{ request.body }}`      | Request body         | `{"name": "test"}`     |

### Conditions (reject.if)

| Operator     | Example                              |
| ------------ | ------------------------------------ |
| `contains`   | `request.url contains "/admin"`      |
| `startsWith` | `request.url startsWith "/internal"` |
| `endsWith`   | `request.url endsWith ".xml"`        |
| `==`         | `env.MAINTENANCE == "true"`          |
| `!=`         | `request.method != "GET"`            |

### YAML Function Transform Examples

#### Example 1: Add API Token

```yaml
# functions/tickets/index.yml
target: "{{ env.INTERNAL_API_URL }}"
request:
  headers:
    set:
      authorization: "Bearer {{ env.INTERNAL_API_TOKEN }}"
```

#### Example 2: URL Rewriting

```yaml
# functions/tickets/index.yml
target: "{{ env.INTERNAL_API_URL }}"
request:
  url:
    removePrefix: "/external"
    prefix: "/internal/api/v3"
```

Result: `/external/users` → `/internal/api/v3/users`

#### Example 3: Maintenance Mode

```yaml
# functions/tickets/index.yml
target: "{{ env.INTERNAL_API_URL }}"
request:
  reject:
    if: 'env.MAINTENANCE == "true"'
    code: "SERVICE_UNAVAILABLE"
    message: "System is under maintenance"
```

#### Example 4: Block Admin Routes

```yaml
# functions/tickets/index.yml
target: "{{ env.INTERNAL_API_URL }}"
request:
  reject:
    if: 'request.url contains "/admin"'
    code: "FORBIDDEN"
    message: "Admin access through the Cloud Connector is not allowed"
```

#### Example 5: Response Headers for Debugging

```yaml
# functions/tickets/index.yml
target: "{{ env.INTERNAL_API_URL }}"
response:
  headers:
    add:
      x-connector-request-id: "{{ context.requestId }}"
      x-connector-timestamp: "{{ context.startedAt }}"
```

---

## Configuration

| Variable                                     | Description                                                   |
| -------------------------------------------- | ------------------------------------------------------------- |
| `CONNECTOR_HOST`                             | HTTP server bind address (default: `0.0.0.0`)                 |
| `CONNECTOR_PORT`                             | HTTP server port (default: `8080`)                            |
| `CLOUD_CONNECTOR_WS_URL`                     | WebSocket URL to the Serviceware Cloud                        |
| `CLOUD_CONNECTOR_HOST`                       | Serviceware Cloud base URL for authentication                 |
| `CLOUD_CONNECTOR_CLIENT_ID`                  | OAuth client ID for the cloud connection                      |
| `CLOUD_CONNECTOR_CLIENT_SECRET`              | OAuth client secret for the cloud connection                  |
| `CLOUD_CONNECTOR_FUNCTIONS_DIR`              | Path to the functions directory                               |
| `CLOUD_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS` | Heartbeat interval (default: `30`)                            |
| `CLOUD_CONNECTOR_LOG_LEVEL`                  | Log level: `error`, `warn`, `info`, `debug` (default: `info`) |
| `OUTBOUND_URL_ALLOWLIST`                     | JSON array of regexes for allowed workload URLs (default: `[]`, deny all) |

### Outbound URL allowlist

The Cloud Connector denies all workload HTTP requests by default. This policy
applies to transparent proxy mode, YAML functions, SDK upstream/proxy helpers,
and direct `fetch` calls inside TypeScript functions. The mandatory OAuth and
WebSocket control-plane connection to the Serviceware Cloud is separate from this policy.

Set `OUTBOUND_URL_ALLOWLIST` to a JSON array of regular-expression strings. A
request is allowed when at least one expression matches its normalized,
absolute URL. Redirect targets are checked again before they are requested.
Invalid JSON or regular expressions stop startup with a configuration error.

```env
# Default: no workload URL is reachable
OUTBOUND_URL_ALLOWLIST=[]

# Allow one HTTPS domain, including all paths
OUTBOUND_URL_ALLOWLIST=["^https://api[.]example[.]com(?:/|$)"]

# Allow multiple targets
OUTBOUND_URL_ALLOWLIST=["^https://api[.]example[.]com(?:/|$)","^http://erp:8080(?:/|$)"]

# Explicitly allow every URL (not recommended)
OUTBOUND_URL_ALLOWLIST=[".*"]
```

Anchor domain expressions with `^` and a host boundary such as `(?:/|$)` to
avoid unintentionally matching lookalike domains. Configuration changes take
effect after restarting the Cloud Connector.

### Resilience tuning

The Cloud Connector keeps its outbound WebSocket alive on its own. These knobs
control the reconnect behaviour; the defaults are production-ready.

| Variable                                    | Default | Description                                                                                                                                                       |
| ------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUD_CONNECTOR_RECONNECT_INITIAL_SECONDS` | `1`     | Initial reconnect backoff delay.                                                                                                                                  |
| `CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS`     | `30`    | Maximum reconnect backoff delay (the Cloud Connector never gives up; it keeps retrying at this cap).                                                              |
| `CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO`    | `0.5`   | Fraction of the backoff that is randomized (equal jitter, `0`–`1`) to avoid thundering herds. `0` = deterministic.                                                |
| `CLOUD_CONNECTOR_RECONNECT_STABLE_SECONDS`  | `5`     | A connection must stay open at least this long before the backoff counter resets (anti-flap).                                                                     |
| `CLOUD_CONNECTOR_CONNECT_TIMEOUT_SECONDS`   | `10`    | Max wait for the WebSocket to open before retrying (bounds half-open / black-hole sockets).                                                                       |
| `CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR`  | `3`     | Force-close + reconnect after this many heartbeat intervals without any inbound frame. `0` disables the watchdog.                                                 |
| `CLOUD_CONNECTOR_TOKEN_TIMEOUT_SECONDS`     | `10`    | Timeout for the OAuth token fetches (prevents a hung auth endpoint from stalling reconnects).                                                                     |
| `CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS`    | `120`   | `/health` reports unhealthy if the supervision loop is silent this long. Must be **greater** than `CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS` (validated at startup). |

---

## Fault tolerance

The runtime is designed to never stay down:

- **In-process recovery.** The WebSocket reconnects with **exponential backoff +
  jitter** and never gives up. Half-open ("wedged") sockets are detected by a
  peer-liveness watchdog and force-closed so a fresh connection is built. The
  reconnect loop is uncrashable, and a global `unhandledrejection`/`error`
  safety net keeps a stray steady-state fault from terminating the process. The
  HTTP server, WebSocket client, and functions watcher are supervised and
  restarted in-process if they ever stop unexpectedly.
- **External supervisor.** Run with `restart: always` (docker-compose), so the
  container also recovers from OOM, `SIGKILL`, a Docker daemon restart, and host
  reboot. The only intentional stop is `docker compose down`.
- **Visible by design.** An unrecoverable **configuration** error exits with a
  distinct code (`78`) instead of retrying forever — fix the config and the
  supervisor restarts a clean process. A wedged Cloud Connector fails `/health`
  so the orchestrator restarts it; a Cloud Connector that is merely reconnecting
  keeps passing `/health` (so it is not killed mid-recovery) but reports
  `/ready` = `503`.

## Health Endpoints

| Endpoint      | Description                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health` | **Liveness.** `200 {"status":"ok"}` while the process is recoverable; `503` only when the supervision loop is wedged. Use for Docker `HEALTHCHECK` / Kubernetes `livenessProbe`.                  |
| `GET /ready`  | **Readiness.** `200` only when the cloud WebSocket is connected (or none is configured); `503 {"websocketConnected":false}` while disconnected/reconnecting. Use for Kubernetes `readinessProbe`. |
| `GET /ws`     | WebSocket upgrade endpoint for local testing                                                                                                                                                      |

---

## Examples

| Example                                                                     | Description                           |
| --------------------------------------------------------------------------- | ------------------------------------- |
| [`templates/starter/`](templates/starter)                                   | Starter template for new projects     |
| [`templates/examples/ad-user-export/`](templates/examples/ad-user-export)   | AD integration with Python bridge     |
| [`templates/examples/erp-integration/`](templates/examples/erp-integration) | SAP OData integration                 |
| [`templates/examples/ticketing-yaml/`](templates/examples/ticketing-yaml)   | Declarative YAML Functions (no code!) |

---

## Development

### Prerequisites

- [Deno](https://deno.land/) >= 2.0

### Tasks

```bash
cd cloud-connector

# Development mode with hot reload
deno task dev

# Generate API models from OpenAPI
deno task generate:api

# Type check
deno task check

# Linting
deno task lint

# Run tests
deno task test

# Production start
deno task start
```

The repository root is a Deno workspace for the local SDK and runtime packages.
Templates under `templates/` remain standalone examples with their own
`deno.json` files and are not workspace members.

### Use the SDK (for Customers)

```bash
# Copy starter template
cp -r cloud-connector/templates/starter my-cloud-connector
cd my-cloud-connector

# Type check
deno task check

# Start with Docker
docker-compose up -d
```

### Project Structure

```
cloud-connector/
├── CHANGELOG.md             # Release notes and migration requirements
├── Dockerfile              # Docker image definition
├── README.md               # This documentation
├── docs/
│   ├── INSTALLATION.md      # Customer installation guide
│   └── RELEASE.md           # Maintainer release checklist
├── openapi/
│   └── api.yml             # WebSocket protocol schema
├── sdk/                    # SDK package (@serviceware/cloud-connector-sdk)
│   ├── deno.json           # Package configuration (JSR)
│   ├── mod.ts              # Barrel exports
│   ├── types.ts            # Type definitions
│   ├── errors.ts           # RuntimeError, ErrorCodes
│   └── README.md           # SDK documentation
├── runtime/                # Runtime (Docker image)
│   ├── deno.json           # Runtime configuration
│   ├── main.ts             # HTTP server and entry point
│   ├── config.ts           # Environment variable loader
│   ├── connector.ts        # Core runtime
│   ├── function-router.ts  # Function execution
│   ├── function-scanner.ts # File-based function discovery
│   ├── protocol.ts         # WebSocket frame handling
│   ├── outbound-url-policy.ts # Default-deny HTTP URL policy
│   ├── yaml-functions.ts   # Declarative YAML functions
│   ├── websocket-client.ts # Outbound WebSocket client
│   ├── generated/          # Generated TypeScript models
│   └── *.spec.ts           # Tests
└── templates/              # Customer templates
    ├── starter/            # Quickstart template
    │   ├── deno.json       # With SDK import
    │   ├── docker-compose.yml
    │   └── README.md       # Guide
    └── examples/           # Reference implementations
        ├── ad-user-export/
        ├── erp-integration/
        └── ticketing-yaml/
```

---

## Security

- **Outbound only**: No inbound connections required
- **Default-deny workload HTTP**: Every target and redirect must match
  `OUTBOUND_URL_ALLOWLIST`
- **TLS**: WebSocket connections should always use `wss://`
- **Trusted functions**: TypeScript/JavaScript functions run in the Edge
  Connector process; deploy only reviewed function code
- **No secrets in logs**: Sensitive headers are not logged

---

## Troubleshooting

### WebSocket Does Not Connect

The Cloud Connector retries forever with exponential backoff, so a transient
outage heals on its own. If it never connects:

1. Check `CLOUD_CONNECTOR_WS_URL` (must use `ws://` or `wss://`)
2. Check `CLOUD_CONNECTOR_HOST`, `CLOUD_CONNECTOR_CLIENT_ID`, and
   `CLOUD_CONNECTOR_CLIENT_SECRET`
3. Check firewall rules for outbound connections
4. Check the logs: `docker logs <container>` and the `/ready` endpoint (`503` =
   not connected yet)

### Container Keeps Restarting

A fast crash-restart loop with a `FATAL: invalid configuration` log line (exit
code `78`) means a misconfiguration the Cloud Connector deliberately refuses to
retry in-process. Fix the reported environment variable and the container
restarts cleanly. (A wedged Cloud Connector that fails `/health` is restarted by
Docker on purpose — that is recovery, not a fault.)

### Function Is Not Loaded

1. Check the path in `CLOUD_CONNECTOR_FUNCTIONS_DIR`
2. Check the file extension (`.ts`, `.js`, `.mts`, `.mjs`, `.yml`, `.yaml`)
3. For Docker: Is the functions volume mounted correctly?

### Request Is Rejected

Check the error code in the response:

| Code                 | Cause                                      |
| -------------------- | ------------------------------------------ |
| `YAML_PARSE_ERROR`   | Invalid YAML                               |
| `REQUEST_REJECTED`   | Request was rejected by a `reject` rule    |
| `OUTBOUND_URL_NOT_ALLOWED` | Target or redirect is not allowlisted |
| `METHOD_NOT_ALLOWED` | Route exists, but not for this HTTP method |
| `NOT_FOUND`          | No function handler matched the request    |
