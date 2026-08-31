# Cloud Connector installation

## Requirements

- Docker Engine with Docker Compose
- outbound HTTPS access to the Serviceware Cloud
- network access from the container to exactly one configured HTTP(S) target
- Serviceware Cloud host, WebSocket URL, client ID, and client secret

The deployment does not require Deno, Node.js, a compiler, or a customer script
runtime on the host.

## Prepare the deployment

```bash
cp -R templates/starter cloud-connector
cd cloud-connector
cp .env.example .env
```

Set the Serviceware Cloud values and the internal target in `.env`. Configure an
anchored allowlist expression for that target. The connector will not forward
anything while the allowlist is empty.

Example:

```env
SERVICEWARE_HOST=https://dev.ai-process-engine.labs.swops.cloud
SERVICEWARE_WS_URL=wss://cloud.serviceware.se/connector/ws?tenant=my-tenant
SERVICEWARE_CLIENT_ID=my-client
SERVICEWARE_CLIENT_SECRET=change-me
INTERNAL_API_URL=https://internal-api.example.com
INTERNAL_API_TOKEN=change-me
OUTBOUND_URL_ALLOWLIST=["^https://internal-api[.]example[.]com(?:/|$)"]
```

Keep `.env` outside version control and restrict it to the deployment account.

## Configure forwarding

`forwarding.yml` is the only customer-controlled behavior file. It selects one
target for every workload request and may apply the documented declarative
transforms.

```yaml
target: "{{ env.INTERNAL_API_URL }}"
methods: [GET, POST]
timeout: 30000
request:
  headers:
    set:
      authorization: "Bearer {{ env.INTERNAL_API_TOKEN }}"
  url:
    prefix: /api
response:
  headers:
    remove: [server, x-powered-by]
```

The connector never scans a source directory and never loads TypeScript,
JavaScript, Python, or another executable extension. An inbound absolute URL
cannot override the target origin from YAML.

The compose file mounts the configuration read-only:

```yaml
environment:
  - CLOUD_CONNECTOR_FORWARDING_CONFIG=/config/forwarding.yml
  - OUTBOUND_URL_ALLOWLIST=${OUTBOUND_URL_ALLOWLIST:-[]}
volumes:
  - ./forwarding.yml:/config/forwarding.yml:ro
```

## Start and verify

```bash
docker compose pull
docker compose up -d
docker compose ps
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
docker compose logs --tail=100 cloud-connector
```

`/health` verifies process supervision. `/ready` remains 503 until the cloud
WebSocket is connected. Configuration is validated before either endpoint is
bound, so a missing or malformed YAML file produces a clear startup error and a
container restart loop.

## Update configuration

The YAML file is immutable for a running process. Validate the change, replace
the file, and restart:

```bash
docker compose restart cloud-connector
docker compose logs --tail=100 cloud-connector
```

No live code reload or route recomposition exists.

## Network policy

Allow the container to reach:

- the Serviceware Cloud OAuth endpoint over HTTPS;
- the configured Serviceware Cloud WebSocket endpoint over WSS; and
- the YAML target and any permitted redirect destinations.

Apply an infrastructure egress policy in addition to `OUTBOUND_URL_ALLOWLIST`.
The application allowlist matches normalized absolute URLs and rechecks every
redirect. Prefer expressions such as:

```env
OUTBOUND_URL_ALLOWLIST=["^https://api[.]example[.]com(?::8443)?(?:/|$)"]
```

Avoid unanchored hostname fragments. `[".*"]` is an explicit unrestricted
configuration, not a safe production default.

## Systemd wrapper (optional)

```ini
[Unit]
Description=Cloud Connector
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/cloud-connector
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
```

## Troubleshooting

| Symptom                        | Check                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Container restarts immediately | YAML mount, `CLOUD_CONNECTOR_FORWARDING_CONFIG`, YAML syntax, required `target` |
| `OUTBOUND_URL_NOT_ALLOWED`     | JSON syntax, regex anchoring, target port/path, redirect destination            |
| `/ready` returns 503           | cloud URL, credentials, DNS, firewall, TLS, WebSocket path                      |
| Upstream receives wrong path   | `request.url` transforms in `forwarding.yml`                                    |
| `METHOD_NOT_ALLOWED`           | `methods` list in `forwarding.yml`                                              |
| Upstream timeout               | YAML `timeout`, target availability, network policy                             |

Do not mount source-code directories into the container. They are not supported
and are not read by the runtime.
