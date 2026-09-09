# Ticketing example

This example forwards Serviceware Cloud calls to one ticketing API.

Copy .env.example to .env, enter the credentials, and review
config/cloud-connector.yml before starting:

```bash
docker compose up -d
curl --fail http://localhost:8080/health
```

The YAML file sets the target, path prefix, headers, timeout, heartbeat, and log
level. Changes take effect while the connector is running.
