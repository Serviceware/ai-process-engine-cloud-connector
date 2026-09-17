# Architecture conventions

## Product boundary

The Cloud Connector is a forward proxy between Serviceware Cloud and explicitly
allowed internal HTTP services. It maintains an outbound WebSocket connection,
executes approved HTTP requests, and returns text responses over the cloud
protocol.

It does not execute customer code, expose a local WebSocket server, discover
targets, or act as a general-purpose network tunnel. New features must fit the
forward-proxy boundary.

## Runtime flow

1. `runtime/main.ts` reads process configuration and the mounted YAML file.
2. `runtime/websocket-client.ts` derives and maintains the Serviceware Cloud
   connection.
3. `runtime/protocol.ts` validates and serializes protocol frames.
4. `runtime/connector.ts` applies concurrency and drain behavior.
5. `runtime/yaml-forwarding.ts` resolves the forwarding policy and calls the
   selected HTTP target.
6. `runtime/runtime-status.ts` supplies state for the local health endpoints.

Keep these responsibilities separated. Protocol handling must not silently
bypass forwarding policy, and configuration loading must not perform network
work.

## Configuration lifecycle

Process-level values come from environment variables. The forwarding policy,
connection purpose, heartbeat interval, and log level come from
`/config/cloud-connector.yml`.

The YAML configuration is a validated snapshot. A reload must construct all
fallible replacement components before changing live state. Invalid updates
leave the last-known-good snapshot active. In-flight requests keep the snapshot
with which they started.

Watch the containing configuration directory so atomic replacements and
projected-volume symlink updates are detected. Do not replace this with a
file-only watch without preserving those semantics.

## Local HTTP interface

The runtime binds `0.0.0.0:8080` only for probes:

- `/health` reports whether the supervision loop is alive.
- `/ready` reports whether the outbound cloud connection is open and includes
  connection and reload status.

All other paths return `404`. Do not add proxy traffic to this local interface.

## Contracts and generated code

`openapi/api.yml` is the cloud protocol source. Files under `runtime/generated/`
are generated artifacts and must not be hand-edited.
`schemas/cloud-connector.schema.json` is the public YAML configuration contract
and must stay consistent with runtime validation in `runtime/config.ts`.
