# Installation

Deploy the Serviceware AI Process Engine - Cloud Connector as a container with
outbound network access to Serviceware AI Process Engine and the explicitly
allowed internal target services.

## Production deployment

Use a container orchestrator such as Kubernetes or Nomad and inject credentials
through its secret store. The image is private. Use a GitHub account with read
access to the `cloud-connector` package and a classic personal access token with
the `read:packages` scope. Authorize the token for the Serviceware organization
if SSO is required. Load the token through your secret manager, then log in
without putting the token on the command line:

```bash
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin
docker pull ghcr.io/serviceware/cloud-connector:1.0.0
```

For production, provide equivalent registry credentials through the
orchestrator's secret mechanism; do not commit them to deployment manifests.

The `latest` tag points to the most recently promoted release. For repeatable
rollouts, resolve it once and deploy the validated image digest.

Configure the workload with:

- the required `CLOUD_CONNECTOR_HOST`, `CLOUD_CONNECTOR_CLIENT_ID`, and
  `CLOUD_CONNECTOR_CLIENT_SECRET` environment variables;
- any target secrets referenced by `cloud-connector.yml`;
- one read-only directory mounted at `/config`; and
- an optional port mapping for the probe service on container port `8080`.

The OAuth service account needs the **Advanced Cloud Connector** permission. See
the [complete environment variable table](../README.md#environment-variables)
for optional resilience and safety settings.

Place `cloud-connector.yml` in the mounted directory. Each forwarding target
must be a safe regular expression over the complete absolute URL, anchored with
`^` and `$`. Mount the directory instead of only the file so projected-volume
and atomic replacement updates can be detected.

You do not need to create a connector purpose manually. Serviceware AI Process
Engine creates the configured `connection.purpose` when the connector connects
for the first time.

Do not store credentials in a container manifest. Reference secrets managed by
the deployment platform, and restrict access to both those secrets and the
mounted forwarding policy.

## Local testing with Docker Compose

The maintained Compose files are intended for local testing and as deployment
references only:

- [starter template](../templates/starter);
- [ticketing example](../templates/examples/ticketing-yaml).

Copy one of the directories, edit `config/cloud-connector.yml`, and replace the
placeholder environment values in `docker-compose.yml`. The populated Compose
file contains secrets in clear text, so never commit it or use it as-is in
production. Log in to GHCR as described above before starting the stack.

Start and inspect a local test with:

```bash
docker compose up -d
docker compose logs -f
```

Check its status in another terminal:

```bash
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
```

`/health` confirms that the process is running. `/ready` confirms that the
platform connection is open and reports connection timestamps, reconnect
attempts, and the result of the latest configuration reload.

For a direct `docker run` example that keeps secret values out of the command,
see [Getting started](../README.md#getting-started).

## Change the configuration

Edit `cloud-connector.yml` in the mounted config directory. Valid changes take
effect without rebuilding the image or restarting the application. An invalid
update is rejected, and the last working configuration remains active.

The defaults allow 100 concurrent forwarded requests, buffer at most 10 MiB per
response, and drain accepted requests for up to 30 seconds before a reconnect or
shutdown. Override them with `CLOUD_CONNECTOR_MAX_CONCURRENT_REQUESTS`,
`CLOUD_CONNECTOR_MAX_RESPONSE_BODY_BYTES`, and
`CLOUD_CONNECTOR_DRAIN_TIMEOUT_SECONDS` when needed. Response bodies are UTF-8
text; binary payloads are not supported by the current platform protocol.

## If it does not connect

- Check the container logs.
- Confirm the Serviceware AI Process Engine host and OAuth credentials.
- Confirm that `CLOUD_CONNECTOR_HOST` and the optional connection `purpose` are
  correct. The WebSocket URL is derived from them automatically.
- Confirm that the service account has the **Advanced Cloud Connector**
  permission.
- Confirm that the complete target URL matches a forwarding rule.
- Validate the YAML file for indentation or typing errors.

If the first connection succeeds, the configured purpose is created
automatically. An invalid YAML update is ignored so the last working setup can
continue to run.
