import type { Server } from "node:http";
import { expect, test, vi } from "vitest";
import { combineConfig, loadEnvironmentConfig, parseVolumeConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { serve } from "./http-server.ts";
import { createHandler, createProtocolExecutor, superviseHttpServer } from "./main.ts";
import { createRuntimeStatus } from "./runtime-status.ts";

const silentLogger = createLogger("error", {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

const environment = () =>
  loadEnvironmentConfig({
    CLOUD_CONNECTOR_HOST: "https://cloud.example",
    CLOUD_CONNECTOR_CLIENT_ID: "client-id",
    CLOUD_CONNECTOR_CLIENT_SECRET: "client-secret",
  });

const config = () =>
  combineConfig(
    environment(),
    parseVolumeConfig(`
connection: {}
forwarding:
  - target: ^https://internal[.]example(?:/.*)?$
`),
  );

test("health stays ok and the removed local WebSocket endpoint is absent", async () => {
  const status = createRuntimeStatus();
  const handler = createHandler(environment(), status);

  const healthResponse = handler(new Request("http://localhost/health"));
  expect(healthResponse.status).toStrictEqual(200);
  expect(await healthResponse.json()).toStrictEqual({ status: "ok" });
  expect(handler(new Request("http://localhost/ws")).status).toStrictEqual(404);
});

test("ready reflects the required outbound WebSocket connection", async () => {
  const status = createRuntimeStatus();
  const handler = createHandler(environment(), status);

  const notReady = handler(new Request("http://localhost/ready"));
  expect(notReady.status).toStrictEqual(503);
  expect(await notReady.json()).toStrictEqual({
    status: "not_ready",
    websocketConnected: false,
    connectionState: "disconnected",
    reconnectAttempt: 0,
    lastConnectedAt: null,
    lastInboundAt: null,
    configReload: { lastAttemptAt: null, succeeded: null },
  });

  status.connectionState = "open";
  const ready = handler(new Request("http://localhost/ready"));
  expect(ready.status).toStrictEqual(200);
  expect(await ready.json()).toStrictEqual({
    status: "ready",
    websocketConnected: true,
    connectionState: "open",
    reconnectAttempt: 0,
    lastConnectedAt: null,
    lastInboundAt: null,
    configReload: { lastAttemptAt: null, succeeded: null },
  });
});

test("health fails only when the supervision loop is stale", async () => {
  const staticConfig = environment();
  const status = createRuntimeStatus(0);
  let clock = staticConfig.livenessStaleMs;
  const handler = createHandler(staticConfig, status, () => clock);

  status.connectionState = "disconnected";
  expect(handler(new Request("http://localhost/health")).status).toStrictEqual(200);

  clock += 1;
  const stale = handler(new Request("http://localhost/health"));
  expect(stale.status).toStrictEqual(503);
  expect(await stale.json()).toMatchObject({ status: "unhealthy" });
});

test("createProtocolExecutor uses only the validated YAML forwarding snapshot", async () => {
  const executor = await createProtocolExecutor(config(), "/config/cloud-connector.yml", silentLogger);

  await expect(
    executor.execute({
      type: "request",
      requestId: "request-1",
      request: { method: "GET", url: "https://blocked.example/health" },
    }),
  ).rejects.toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("forwarding target rule"),
    }),
  );
});

test("superviseHttpServer rebinds after a server error and a later close", async () => {
  const abortController = new AbortController();
  const bind = () =>
    serve(() => new Response("ok"), {
      hostname: "127.0.0.1",
      port: 0,
      signal: abortController.signal,
      logger: silentLogger,
    });
  const initial = await bind();
  const rebound: Server[] = [];
  const supervisor = superviseHttpServer(
    initial,
    async () => {
      const server = await bind();
      rebound.push(server);
      return server;
    },
    abortController.signal,
    silentLogger,
  );

  try {
    initial.emit("error", new Error("accept EMFILE"));
    initial.close();
    await vi.waitFor(() => expect(rebound[0]?.listening).toBeTruthy(), {
      timeout: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(rebound).toHaveLength(1);
    rebound[0].close();
    await vi.waitFor(() => expect(rebound[1]?.listening).toBeTruthy(), {
      timeout: 5_000,
    });
  } finally {
    abortController.abort();
  }
  await supervisor;
});
