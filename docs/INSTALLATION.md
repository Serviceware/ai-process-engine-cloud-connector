# Installation

The connector needs Docker, access to Serviceware Cloud, and network access to
the internal target service.

## Set up

Copy the starter template:

```bash
cp -R templates/starter my-cloud-connector
cd my-cloud-connector
cp .env.example .env
```

Then:

1. Enter the Serviceware host and credentials in .env.
2. Add any secret needed by the internal target to .env.
3. Set the forwarding target rules in config/cloud-connector.yml. Each target is
   a regular expression over the complete absolute URL.

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
connection is open.

## Change the configuration

Edit config/cloud-connector.yml in the mounted config directory. Valid changes
take effect without rebuilding the image or restarting the application.

Keep credentials and secrets in .env or the secret store provided by the
deployment platform. Resilience settings also remain environment variables and
normally do not need adjustment.

## If it does not connect

- Check the container logs.
- Confirm the Serviceware host and credentials.
- Confirm that `CLOUD_CONNECTOR_HOST` and the optional connection `purpose` are
  correct; the WebSocket URL is derived from them automatically.
- Confirm that the complete target URL matches a forwarding rule.
- Validate the YAML file for indentation or typing errors.

An invalid YAML update is ignored, so the last working setup continues to run.
