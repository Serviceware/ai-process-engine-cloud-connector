# Installation

The connector needs Docker, access to Serviceware Cloud, and network access to
the internal target service.

Release images are hosted in the repository's GitHub Container Registry package
and are publicly pullable without authentication:

```bash
docker pull ghcr.io/serviceware/cloud-connector:0.1.0
```

Pin the complete release version in production. The maintained Compose templates
already do this and are updated by the release automation.

## Before you start

- A Cloud Connector with the same `connection.purpose` (default `main`) must
  already exist in the Serviceware Configuration Store.
- The OAuth service account must have the **Advanced Cloud Connector**
  permission.

## Set up

Copy the starter template:

```bash
cp -R templates/starter my-cloud-connector
cd my-cloud-connector
```

Then:

1. Enter the Serviceware host and credentials in docker-compose.yml.
2. Add any secret needed by the internal target to the Compose environment
   section.
3. Set the forwarding target rules in config/cloud-connector.yml. Each target is
   a safe regular expression over the complete absolute URL, anchored with `^`
   and `$`.

The starter contains placeholder credentials and the standard safety limits
directly in docker-compose.yml. Do not commit real credentials. Production
deployments should use the secret mechanism provided by their deployment
platform.

Start the connector:

```bash
docker compose up -d
docker compose logs -f
```

Check its status:

```bash
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
```

/health confirms that the process is running. /ready confirms that the cloud
connection is open and reports connection timestamps, reconnect attempts, and
the result of the latest configuration reload.

## Change the configuration

Edit config/cloud-connector.yml in the mounted config directory. Valid changes
take effect without rebuilding the image or restarting the application.

Keep credentials and secrets in the Compose environment or the secret store
provided by the deployment platform. Resilience settings are also environment
variables and normally do not need adjustment.

The defaults allow 100 concurrent forwarded requests, buffer at most 10 MiB per
response, and drain accepted requests for up to 30 seconds before a reconnect or
shutdown. Override them with `CLOUD_CONNECTOR_MAX_CONCURRENT_REQUESTS`,
`CLOUD_CONNECTOR_MAX_RESPONSE_BODY_BYTES`, and
`CLOUD_CONNECTOR_DRAIN_TIMEOUT_SECONDS` when needed. Response bodies are UTF-8
text; binary payloads are not supported by the current protocol.

## If it does not connect

- Check the container logs.
- Confirm the Serviceware host and credentials.
- Confirm that `CLOUD_CONNECTOR_HOST` and the optional connection `purpose` are
  correct. The WebSocket URL is derived from them automatically.
- Confirm that the service account has **Advanced Cloud Connector** permission
  and that the matching connector purpose exists in Configuration Store.
- Confirm that the complete target URL matches a forwarding rule.
- Validate the YAML file for indentation or typing errors.

An invalid YAML update is ignored, so the last working setup continues to run.
