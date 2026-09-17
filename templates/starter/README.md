# Cloud Connector starter

This template connects Serviceware Cloud to explicitly allowed internal HTTP
targets.

## Use it

1. Enter the Serviceware credentials and target secrets directly in
   docker-compose.yml.
2. Edit config/cloud-connector.yml and set the target rules.
3. Start and check the connector:

```bash
docker compose up -d
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
```

Changes to cloud-connector.yml take effect while the connector is running.
Invalid changes are ignored and the previous working setup remains active. Do
not commit real credentials from docker-compose.yml.
