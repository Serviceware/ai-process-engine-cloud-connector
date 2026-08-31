# Cloud Connector starter template

This template runs the Cloud Connector with one declarative YAML forwarding
configuration. Customer TypeScript, JavaScript, and other executable extension
code are not supported or loaded.

## Configure

```bash
cp .env.example .env
```

Edit `.env` with the Serviceware Cloud credentials, the internal target URL, and
its credentials. `OUTBOUND_URL_ALLOWLIST` is a JSON array of regular expressions
and remains default-deny. The configured target must match at least one
expression; use `[".*"]` only when unrestricted workload access is an
intentional security decision.

Edit `forwarding.yml` to configure the one upstream target, optional method
restrictions, timeout, and declarative request/response transformations. Every
inbound workload path and query string is forwarded to that target. There are no
route files and no script hooks.

## Start

```bash
docker compose up -d
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
docker compose logs -f
```

Configuration changes require a container restart:

```bash
docker compose restart cloud-connector
```

## Files

```text
.
├── .env.example
├── docker-compose.yml
└── forwarding.yml
```

The compose file mounts only `forwarding.yml` into the container. No customer
source directory is mounted or executed.
