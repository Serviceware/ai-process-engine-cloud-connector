import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { expect, test, vi } from "vitest";
import { combineConfig, loadEnvironmentConfig, parseVolumeConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { serve } from "./http-server.ts";
import { createHandler, createProtocolExecutor, createRuntimeBundle, superviseHttpServer } from "./main.ts";
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

test("handler answers unknown paths with 404 and reports config reload state in /ready", async () => {
  const status = createRuntimeStatus();
  status.lastReloadAt = 1_700_000_000_000;
  status.lastReloadSucceeded = false;
  status.reconnectAttempt = 3;
  const handler = createHandler(environment(), status);

  const missing = handler(new Request("http://localhost/metrics"));
  expect(missing.status).toStrictEqual(404);
  expect(await missing.text()).toStrictEqual("Not found");

  const ready = handler(new Request("http://localhost/ready"));
  expect(await ready.json()).toMatchObject({
    reconnectAttempt: 3,
    configReload: { lastAttemptAt: 1_700_000_000_000, succeeded: false },
  });
});

test("createRuntimeBundle announces startup and builds an executor enforcing the forwarding policy", async () => {
  const info = vi.fn<(...data: unknown[]) => void>();
  const logger = { ...silentLogger, info };

  const bundle = await createRuntimeBundle(config(), "/config/cloud-connector.yml", logger);

  expect(info).toHaveBeenCalledWith("Starting Cloud Connector forward proxy");
  await expect(
    bundle.protocolExecutor.execute({
      type: "request",
      requestId: "request-1",
      request: { method: "GET", url: "https://blocked.example/health" },
    }),
  ).rejects.toThrow(expect.objectContaining({ name: "RuntimeError" }));
});

function fakeServer(listening: boolean): Server {
  return Object.assign(new EventEmitter(), { listening }) as unknown as Server;
}

test("superviseHttpServer retries a failed rebind and logs the cause", async () => {
  vi.useFakeTimers();
  try {
    const abortController = new AbortController();
    const error = vi.fn<(...data: unknown[]) => void>();
    const logger = { ...silentLogger, error };
    const cause = new Error("EADDRINUSE");
    const recovered = fakeServer(true);
    const rebind = vi.fn<() => Promise<Server>>().mockRejectedValueOnce(cause).mockResolvedValueOnce(recovered);
    const initial = fakeServer(false);

    const supervisor = superviseHttpServer(initial, rebind, abortController.signal, logger);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(rebind).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("Failed to rebind HTTP server", cause);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(rebind).toHaveBeenCalledTimes(2);

    abortController.abort();
    recovered.emit("close");
    await supervisor;
  } finally {
    vi.useRealTimers();
  }
});

test("superviseHttpServer does not rebind once the signal is aborted", async () => {
  const abortController = new AbortController();
  const server = fakeServer(true);
  const rebind = vi.fn<() => Promise<Server>>();
  const supervisor = superviseHttpServer(server, rebind, abortController.signal, silentLogger);

  abortController.abort();
  server.emit("close");
  await supervisor;

  expect(rebind).not.toHaveBeenCalled();
});
