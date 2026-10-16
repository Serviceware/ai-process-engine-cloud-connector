# Serviceware AI Process Engine - Cloud Connector

The Serviceware AI Process Engine - Cloud Connector is a small forward proxy
that connects Serviceware AI Process Engine to explicitly allowed internal HTTP
services. It receives requests over an outbound WebSocket connection, applies
the configured forwarding rules, and returns the target response.

```text
Serviceware AI Process Engine  <──── outbound WebSocket ────  Cloud Connector  ──── HTTP ────>  internal services
         (cloud)                   (opened by the connector)   (your network)                  (allowed by rules)
```

The connector opens the connection itself, so you do not need to open any
inbound firewall port for Serviceware AI Process Engine.

## When do you need a Cloud Connector?

Serviceware AI Process Engine runs in the cloud. Whenever a process has to call
an HTTP service that the cloud cannot reach directly, the Cloud Connector
provides that path from inside your network.

**You need a Cloud Connector when:**

- the target service runs on premises or in a private network, for example an
  internal ticketing system, CMDB, ERP, or HR API at
  `https://tickets.corp.local`;
- the service is only reachable through VPN, a private cloud network, or behind
  a firewall that blocks incoming connections from the internet;
- your security policy does not allow opening inbound firewall ports or
  publishing the service on the internet;
- credentials for the internal service should stay inside your network. The
  connector adds them to the request locally, for example from
  `{{ env.INTERNAL_API_TOKEN }}`, so Serviceware AI Process Engine never needs
  to know them; or
- you want one central, auditable place inside your network that decides which
  internal URLs and HTTP methods the cloud may use. Everything that no
  forwarding rule allows is denied.

**You do not need a Cloud Connector when:**

- the target service is already publicly reachable over the internet, such as a
  SaaS API with a public HTTPS endpoint. Serviceware AI Process Engine can
  usually call such services without a connector;
- your organization already publishes the internal service securely, for example
  through an API gateway or reverse proxy that Serviceware AI Process Engine can
  reach; or
- the process does not call any external system.

**The Cloud Connector cannot help when:**

- the target does not speak HTTP or HTTPS, for example direct database
  connections, SMB file shares, LDAP, or message queues. Put an HTTP API in
  front of such systems first;
- the target returns binary content such as PDFs or images. Responses are
  forwarded as UTF-8 text only; or
- the Docker host itself cannot reach the target service or cannot open an
  outbound HTTPS connection to Serviceware AI Process Engine.

## Getting started

This guide runs the connector as a single Docker container. Every step shows the
commands for Linux or macOS with **Bash** and for Windows with **PowerShell**.
If you are new to Docker, follow the steps in order; each step explains what the
command does.

### Prerequisites

You need:

- Docker:
  - on Linux, [Docker Engine](https://docs.docker.com/engine/install/);
  - on Windows or macOS, [Docker Desktop](https://docs.docker.com/desktop/). On
    Windows, Docker Desktop must run **Linux containers** (the default setting);
- network access from the Docker host to Serviceware AI Process Engine and to
  the internal target services;
- an OAuth service account with the **Advanced Cloud Connector** permission. You
  receive its client ID and client secret from your Serviceware AI Process
  Engine administrator; and
- a GitHub account with read access to the private
  [container package](https://github.com/orgs/Serviceware/packages/container/package/cloud-connector)
  and a classic personal access token with the `read:packages` scope.

Check that Docker works before you continue. Both commands work in Bash and
PowerShell:

```bash
docker version
docker run --rm hello-world
```

The second command downloads a tiny test image and prints `Hello from Docker!`.
If it fails, fix the Docker installation first.

You do not need to create a connector purpose manually. Serviceware AI Process
Engine creates the configured `connection.purpose` when the connector connects
for the first time.

### 1. Create a working directory

Create a directory for the connector with a `config` subdirectory. Run all
following commands from that working directory.

Bash:

```bash
mkdir -p cloud-connector/config
cd cloud-connector
```

PowerShell:

```powershell
mkdir cloud-connector\config
cd cloud-connector
```

### 2. Write the configuration file

Create `config/cloud-connector.yml` with a text editor, for example
`nano config/cloud-connector.yml` in Bash or
`notepad config\cloud-connector.yml` in PowerShell. Start with this content and
replace the example target with your internal service:

```yaml
connection:
  purpose: main
  heartbeatIntervalSeconds: 30

logging:
  level: info

forwarding:
  - target: "^https://internal-api[.]example[.]com(?:/.*)?$"
    methods: [GET, POST]
    timeout: 30000
    request:
      auth:
        type: bearer
        token: "{{ env.INTERNAL_API_TOKEN }}"
```

What the file means:

| Setting                               | Meaning                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `connection.purpose`                  | Name under which the connector registers in Serviceware AI Process Engine.                                             |
| `connection.heartbeatIntervalSeconds` | How often the connector and the platform confirm that the connection is alive.                                         |
| `logging.level`                       | `error`, `warn`, `info`, or `debug`.                                                                                   |
| `forwarding[].target`                 | Regular expression that must match the **complete** target URL. `^` and `$` anchor it; `[.]` matches a literal dot.    |
| `forwarding[].methods`                | HTTP methods that this rule allows.                                                                                    |
| `forwarding[].timeout`                | Target request timeout in milliseconds.                                                                                |
| `forwarding[].request.auth`           | Credentials the connector adds when it calls the target. `{{ env.INTERNAL_API_TOKEN }}` reads an environment variable. |

The example target allows `https://internal-api.example.com` and every path
below it, such as `https://internal-api.example.com/tickets/42`, but not
`https://internal-api.example.com.evil.test`.

Every target is denied unless its complete absolute URL matches at least one
forwarding rule. See the
[configuration schema](schemas/cloud-connector.schema.json) for the complete
YAML contract and the [starter template](templates/starter/config) for a
commented example with header rules.

> [!TIP]
> Indent YAML with spaces, never with tabs. Editors such as VS Code validate the
> file against the schema when you add
> `# yaml-language-server: $schema=<path-to>/cloud-connector.schema.json` as its
> first line.

### 3. Log in to the container registry

The image is stored in the private GitHub Container Registry (GHCR). Docker must
log in once per machine before it can download the image. The login is stored in
the Docker credential store, so you do not need to repeat it for later
downloads.

Bash (`read -s` prompts for the token without showing it on screen):

```bash
read -rp "GitHub user name: " GHCR_USERNAME
read -rsp "GitHub token: " GHCR_TOKEN; echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin
unset GHCR_TOKEN
```

PowerShell:

```powershell
$GhcrUsername = Read-Host "GitHub user name"
$GhcrToken = Read-Host "GitHub token" -AsSecureString
[System.Net.NetworkCredential]::new("", $GhcrToken).Password |
  docker login ghcr.io -u $GhcrUsername --password-stdin
Remove-Variable GhcrToken
```

Docker prints `Login Succeeded`. If your organization uses SSO, authorize the
token for the Serviceware organization in your GitHub token settings first. See
[Installation](docs/INSTALLATION.md#production-deployment) for production
registry credentials.

### 4. Provide the connection variables and secrets

The connector reads its credentials from environment variables. You need the
three required connection variables and every target secret that
`cloud-connector.yml` references with `{{ env.NAME }}`; in the example above
that is `INTERNAL_API_TOKEN`.

| Variable                        | Example value                        |
| ------------------------------- | ------------------------------------ |
| `CLOUD_CONNECTOR_HOST`          | `https://your-tenant.example.com`    |
| `CLOUD_CONNECTOR_CLIENT_ID`     | `application-account-cloudconnector` |
| `CLOUD_CONNECTOR_CLIENT_SECRET` | the OAuth client secret              |
| `INTERNAL_API_TOKEN`            | the token for your internal API      |

Set the variables in the **same terminal window** in which you start the
container in step 5. Environment variables only exist in that terminal session
and are lost when you close it. Enter secrets through a hidden prompt instead of
typing them into the command line, so they do not end up in your shell history.

Bash:

```bash
export CLOUD_CONNECTOR_HOST="https://your-tenant.example.com"
export CLOUD_CONNECTOR_CLIENT_ID="application-account-cloudconnector"
read -rsp "Client secret: " CLOUD_CONNECTOR_CLIENT_SECRET; echo
read -rsp "Internal API token: " INTERNAL_API_TOKEN; echo
export CLOUD_CONNECTOR_CLIENT_SECRET INTERNAL_API_TOKEN
```

PowerShell:

```powershell
$env:CLOUD_CONNECTOR_HOST = "https://your-tenant.example.com"
$env:CLOUD_CONNECTOR_CLIENT_ID = "application-account-cloudconnector"
$env:CLOUD_CONNECTOR_CLIENT_SECRET = [System.Net.NetworkCredential]::new("",
  (Read-Host "Client secret" -AsSecureString)).Password
$env:INTERNAL_API_TOKEN = [System.Net.NetworkCredential]::new("",
  (Read-Host "Internal API token" -AsSecureString)).Password
```

If your organization uses a secret manager, load the values from it instead. For
example, with Azure Key Vault and the Azure CLI:

```bash
# Bash
export CLOUD_CONNECTOR_CLIENT_SECRET="$(az keyvault secret show --vault-name my-vault --name cloud-connector-client-secret --query value -o tsv)"
```

```powershell
# PowerShell
$env:CLOUD_CONNECTOR_CLIENT_SECRET = az keyvault secret show --vault-name my-vault --name cloud-connector-client-secret --query value -o tsv
```

Check that every variable is set without printing secret values:

Bash:

```bash
for name in CLOUD_CONNECTOR_HOST CLOUD_CONNECTOR_CLIENT_ID CLOUD_CONNECTOR_CLIENT_SECRET INTERNAL_API_TOKEN; do
  [ -n "${!name}" ] && echo "$name is set" || echo "$name is MISSING"
done
```

PowerShell:

```powershell
"CLOUD_CONNECTOR_HOST", "CLOUD_CONNECTOR_CLIENT_ID",
"CLOUD_CONNECTOR_CLIENT_SECRET", "INTERNAL_API_TOKEN" | ForEach-Object {
  if ([Environment]::GetEnvironmentVariable($_)) { "$_ is set" } else { "$_ is MISSING" }
}
```

### 5. Start the container

`--env NAME` without `=value` tells Docker to copy the value of that variable
from your current terminal. This keeps secret values out of the command line and
the shell history. A variable that is not set in the terminal is silently
missing in the container, so run the check from step 4 first.

Bash (`\` continues the command on the next line):

```bash
docker run --detach \
  --name serviceware-ai-process-engine-cloud-connector \
  --restart unless-stopped \
  --publish 8080:8080 \
  --volume "$PWD/config:/config:ro" \
  --env CLOUD_CONNECTOR_HOST \
  --env CLOUD_CONNECTOR_CLIENT_ID \
  --env CLOUD_CONNECTOR_CLIENT_SECRET \
  --env INTERNAL_API_TOKEN \
  ghcr.io/serviceware/cloud-connector:latest
```

PowerShell (`` ` `` at the end of a line continues the command; it must be the
last character on the line):

```powershell
docker run --detach `
  --name serviceware-ai-process-engine-cloud-connector `
  --restart unless-stopped `
  --publish 8080:8080 `
  --volume "${PWD}/config:/config:ro" `
  --env CLOUD_CONNECTOR_HOST `
  --env CLOUD_CONNECTOR_CLIENT_ID `
  --env CLOUD_CONNECTOR_CLIENT_SECRET `
  --env INTERNAL_API_TOKEN `
  ghcr.io/serviceware/cloud-connector:latest
```

Docker downloads the image on the first start and prints the ID of the new
container. What the options do:

| Option                               | Meaning                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `--detach`                           | Runs the container in the background and returns the terminal to you.                           |
| `--name ...`                         | Gives the container a fixed name for later commands such as `docker logs`.                      |
| `--restart unless-stopped`           | Restarts the container after crashes and host reboots unless you stopped it with `docker stop`. |
| `--publish 8080:8080`                | Makes the probe endpoints reachable on port `8080` of the Docker host.                          |
| `--volume "<dir>/config:/config:ro"` | Mounts your local `config` directory read-only as `/config` inside the container.               |
| `--env NAME`                         | Passes the variable `NAME` from your terminal into the container.                               |
| `ghcr.io/...:latest`                 | The image to run. `latest` is the most recent release.                                          |

#### Host side and container side

`--publish` and `--volume` both use the form `host:container`. The part
**before** the colon belongs to your machine and you can choose it freely. The
part **after** the colon belongs to the container and must stay as shown,
because the connector is built to use exactly these values.

| Option                               | Host side (left, changeable)                                        | Container side (right, fixed)                                     |
| ------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `--publish 8080:8080`                | Port on your machine. Pick another one if `8080` is already in use. | `8080` is the port the connector listens on inside the container. |
| `--volume "<dir>/config:/config:ro"` | Any directory on your machine that contains `cloud-connector.yml`.  | `/config` is where the connector looks for `cloud-connector.yml`. |

For example, if port `8080` is taken on your machine and your configuration
lives in `/opt/cloud-connector/config` (Bash) or `D:\cloud-connector\config`
(PowerShell), use:

```bash
--publish 9090:8080 --volume "/opt/cloud-connector/config:/config:ro"
```

```powershell
--publish 9090:8080 --volume "D:\cloud-connector\config:/config:ro"
```

The probes are then reachable at `http://localhost:9090/health` and
`http://localhost:9090/ready`. If you change the container side instead, the
connector either cannot be reached (wrong port) or does not find its
configuration and stops (wrong path).

Keep the following in mind:

- Mount a **directory**, not the single file. Many editors save a file by
  replacing it; the connector only notices that replacement when the whole
  directory is mounted.
- Keep `:ro` (read-only). The connector only reads its configuration, and
  read-only access prevents anything inside the container from changing it.
- The file name inside the directory must be exactly `cloud-connector.yml`.
- The port mapping is only for the local `/health` and `/ready` checks. The
  connection to Serviceware AI Process Engine goes outward and does not use it,
  so you can leave out `--publish` entirely if you do not need the checks from
  the host.

For production, replace `latest` with a fixed release such as
`ghcr.io/serviceware/cloud-connector:1.0.2` or with the image digest that you
validated, so that a restart never changes the version unexpectedly.

> [!NOTE]
> Docker stores the passed variable values in the container configuration.
> Anyone who can run `docker inspect` on the host can read them. Restrict Docker
> access on the host accordingly, and use an orchestrator with a secret store in
> production.

### 6. Check that the connector runs

Check the local probe endpoints. In PowerShell, call `curl.exe`, because `curl`
is an alias for `Invoke-WebRequest` in Windows PowerShell.

Bash:

```bash
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
```

PowerShell:

```powershell
curl.exe --fail http://localhost:8080/health
curl.exe --fail http://localhost:8080/ready
```

`/health` reports whether the process is alive and returns `{"status":"ok"}`.
`/ready` succeeds only while the outbound connection to Serviceware AI Process
Engine is open; it returns `"status":"ready"` together with connection
timestamps, reconnect attempts, and the result of the latest configuration
reload. While the connector is still connecting, or if it cannot connect,
`/ready` answers with HTTP `503` and `"status":"not_ready"`.

If `/ready` does not succeed after a few seconds, look at the logs:

```bash
docker logs serviceware-ai-process-engine-cloud-connector
```

See [If it does not connect](docs/INSTALLATION.md#if-it-does-not-connect) for
the most common causes.

### Everyday Docker commands

These commands work identically in Bash and PowerShell:

| Task                               | Command                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| Show running containers            | `docker ps`                                                    |
| Follow the logs (`Ctrl+C` to quit) | `docker logs -f serviceware-ai-process-engine-cloud-connector` |
| Stop the connector                 | `docker stop serviceware-ai-process-engine-cloud-connector`    |
| Start a stopped connector          | `docker start serviceware-ai-process-engine-cloud-connector`   |
| Remove the container               | `docker rm -f serviceware-ai-process-engine-cloud-connector`   |
| Download the newest image          | `docker pull ghcr.io/serviceware/cloud-connector:latest`       |

You do not need to restart the container after editing `cloud-connector.yml`;
see [Configuration behavior](#configuration-behavior).

To **update** the connector or to **change environment variables**, remove the
container and create it again. Your configuration stays in the local `config`
directory. Set the variables from step 4 in the current terminal, then run:

```bash
docker pull ghcr.io/serviceware/cloud-connector:latest
docker rm -f serviceware-ai-process-engine-cloud-connector
```

Finally, run the `docker run` command from step 5 again.

For a production-oriented setup and troubleshooting guide, see
[Installation](docs/INSTALLATION.md).

### Environment variables

The connector reads the following runtime variables. Target secrets referenced
by `cloud-connector.yml` are additional user-defined variables and have no
connector-defined names or defaults.

| Variable                                    | Required |    Default | Purpose                                                           |
| ------------------------------------------- | :------: | ---------: | ----------------------------------------------------------------- |
| `CLOUD_CONNECTOR_HOST`                      |   Yes    |          — | Base URL of the Serviceware AI Process Engine environment.        |
| `CLOUD_CONNECTOR_CLIENT_ID`                 |   Yes    |          — | OAuth client ID provided for the connector.                       |
| `CLOUD_CONNECTOR_CLIENT_SECRET`             |   Yes    |          — | OAuth client secret provided for the connector.                   |
| `CLOUD_CONNECTOR_RECONNECT_INITIAL_SECONDS` |    No    |        `1` | Initial reconnect delay.                                          |
| `CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS`     |    No    |       `30` | Maximum reconnect delay.                                          |
| `CLOUD_CONNECTOR_CONNECT_TIMEOUT_SECONDS`   |    No    |       `10` | Timeout for opening the platform connection.                      |
| `CLOUD_CONNECTOR_RECONNECT_STABLE_SECONDS`  |    No    |        `5` | Open time after which reconnect backoff resets.                   |
| `CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR`  |    No    |        `3` | Missed-heartbeat tolerance; `0` disables this timeout.            |
| `CLOUD_CONNECTOR_TOKEN_TIMEOUT_SECONDS`     |    No    |       `10` | Timeout for OAuth token requests.                                 |
| `CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO`    |    No    |      `0.5` | Reconnect jitter from `0` to `1`.                                 |
| `CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS`    |    No    |      `120` | Maximum age of the runtime supervision tick.                      |
| `CLOUD_CONNECTOR_MAX_RESPONSE_BODY_BYTES`   |    No    | `10485760` | Maximum buffered target response size.                            |
| `CLOUD_CONNECTOR_MAX_CONCURRENT_REQUESTS`   |    No    |      `100` | Maximum forwarded requests in flight.                             |
| `CLOUD_CONNECTOR_DRAIN_TIMEOUT_SECONDS`     |    No    |       `30` | Time allowed for requests to finish during reconnect or shutdown. |

All durations must be whole seconds. The liveness window must be greater than
the maximum reconnect delay and the configured heartbeat timeout.

To set an optional variable, set it in the terminal like the required ones and
add another `--env NAME` option to `docker run`, for example
`--env CLOUD_CONNECTOR_MAX_CONCURRENT_REQUESTS`.

### Volume

The connector uses one configuration volume:

| Host path  | Container path | Mode      | Required | Purpose                                                  |
| ---------- | -------------- | --------- | :------: | -------------------------------------------------------- |
| `./config` | `/config`      | Read-only |   Yes    | Provides `cloud-connector.yml` and supports hot reloads. |

Mount the directory, not only the file, so atomic file replacements and
projected-volume updates can be detected. The connector listens on port `8080`
for `/health` and `/ready`. Publishing that port is useful for host-based
monitoring but is not required for the outbound platform connection.

### Docker Compose

Docker Compose describes the container options from step 5 in a
`docker-compose.yml` file, so you can start the connector with a short command
instead of a long `docker run` line.

The [starter](templates/starter) and
[ticketing example](templates/examples/ticketing-yaml) contain Docker Compose
files for local testing and as deployment references. If you replace their
placeholders, the resulting Compose files contain secrets in clear text. Do not
use them as-is in production or commit the populated files.

Use a container orchestrator such as Kubernetes or Nomad for production and
inject credentials from its secret store. If you only want to test locally, copy
a template, replace its placeholders, and run the following commands in the
template directory:

```bash
docker compose up -d      # create and start the connector in the background
docker compose logs -f    # follow the logs; Ctrl+C stops following
docker compose down       # stop and remove the connector
```

## Container image

Release images for Linux AMD64 and ARM64 are published privately to the
[container package](https://github.com/orgs/Serviceware/packages/container/package/cloud-connector).
Pulling requires GHCR authentication and package read access. The `latest` tag
points to the most recently published release. For repeatable production
rollouts, deploy the image digest that you validated.

Builds from `main` are also published as `dev` and `sha-<full-commit-sha>` for
integration testing. Do not use these development tags in production. Older
`sha256-<digest>` entries in the package are provenance attestations, not
container images. Pull an image by its semantic version, `dev`, `sha-<commit>`,
or the image digest shown on one of those versions.

## Configuration behavior

`config/cloud-connector.yml` is watched while the connector runs. A valid change
updates logging and forwarding immediately; a connection change causes a
controlled reconnect. Invalid changes are rejected and the last working
configuration stays active. Check `docker logs` after an edit to see whether the
change was accepted.

Forwarding rules are evaluated in order. Later matching rules override earlier
explicit methods, headers, timeouts, and authentication. No matching rule means
deny. Inbound `authorization`, `cookie`, and `proxy-authorization` headers are
removed unless a rule explicitly enables `forwardIncomingCredentials`.

Basic authentication, static Bearer tokens, and OAuth 2.0 client credentials are
supported for targets. Secret values can be interpolated with `{{ env.NAME }}`.
Responses are buffered as UTF-8 text; binary response bodies are not supported
by the current platform protocol.

## Development

Install the Node.js version from `.node-version`, for example with
[fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm),
then let Corepack provide the pinned pnpm, install the locked dependencies, and
run the complete local check suite:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run ci
```

See [Contributing](CONTRIBUTING.md) for the contribution workflow and
[Repository checks](docs/CI.md) for CI details.
