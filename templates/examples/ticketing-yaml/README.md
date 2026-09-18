# Ticketing example

This example forwards Serviceware AI Process Engine calls to one ticketing API.
Use it for local testing or as a deployment reference, not as a production
manifest: populated environment values are stored in clear text. Use an
orchestrator and secret store in production.

Enter the Serviceware and ticketing credentials directly in docker-compose.yml,
then review config/cloud-connector.yml before starting:

```bash
docker compose up -d
curl --fail http://localhost:8080/health
```

The YAML file sets the target rule, authentication, path prefix, headers,
timeout, heartbeat, and log level. Changes take effect while the connector is
running. Do not commit real credentials from docker-compose.yml.
