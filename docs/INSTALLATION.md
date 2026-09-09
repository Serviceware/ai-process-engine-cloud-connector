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
3. Set the cloud connection and the forwarding target in
   config/cloud-connector.yml.
4. Keep the outbound URL allowlist limited to the intended target.

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
- Confirm that the WebSocket URL is correct.
- Confirm that the target is included in the outbound URL allowlist.
- Validate the YAML file for indentation or typing errors.

An invalid YAML update is ignored, so the last working setup continues to run.
