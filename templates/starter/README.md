# Cloud Connector starter

This template connects Serviceware Cloud to one internal HTTP service.

## Use it

1. Copy .env.example to .env and enter the Serviceware credentials.
2. Edit config/cloud-connector.yml and set the cloud connection and target.
3. Start and check the connector:

```bash
docker compose up -d
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
```

Changes to cloud-connector.yml take effect while the connector is running.
Invalid changes are ignored and the previous working setup remains active.
