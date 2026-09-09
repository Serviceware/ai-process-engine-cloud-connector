import { assertEquals, assertRejects } from "@std/assert";
import {
  combineConfig,
  loadEnvironmentConfig,
  parseVolumeConfig,
} from "./config.ts";
import { createLogger } from "./logger.ts";
import { createHandler, createProtocolExecutor } from "./main.ts";
import { RuntimeError } from "./runtime-error.ts";
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
connection:
  websocketUrl: wss://cloud.example/connector/ws
forwarding:
  target: https://internal.example
`),
  );

Deno.test("health stays ok and the removed local WebSocket endpoint is absent", async () => {
  const status = createRuntimeStatus();
  const handler = createHandler(environment(), status);

  const healthResponse = handler(new Request("http://localhost/health"));
  assertEquals(healthResponse.status, 200);
  assertEquals(await healthResponse.json(), { status: "ok" });
  assertEquals(handler(new Request("http://localhost/ws")).status, 404);
});

Deno.test("ready reflects the required outbound WebSocket connection", async () => {
  const status = createRuntimeStatus();
  const handler = createHandler(environment(), status);

  const notReady = handler(new Request("http://localhost/ready"));
  assertEquals(notReady.status, 503);
  assertEquals(await notReady.json(), {
    status: "not_ready",
    websocketConnected: false,
  });

  status.connectionState = "open";
  const ready = handler(new Request("http://localhost/ready"));
  assertEquals(ready.status, 200);
  assertEquals(await ready.json(), {
    status: "ready",
    websocketConnected: true,
  });
});

Deno.test("health fails only when the supervision loop is stale", async () => {
  const staticConfig = environment();
  const status = createRuntimeStatus(0);
  let clock = staticConfig.livenessStaleMs;
  const handler = createHandler(staticConfig, status, () => clock);

  status.connectionState = "disconnected";
  assertEquals(handler(new Request("http://localhost/health")).status, 200);

  clock += 1;
  const stale = handler(new Request("http://localhost/health"));
  assertEquals(stale.status, 503);
  assertEquals((await stale.json()).status, "unhealthy");
});

Deno.test("createProtocolExecutor uses only the validated YAML forwarding snapshot", async () => {
  const executor = await createProtocolExecutor(
    config(),
    "/config/cloud-connector.yml",
    silentLogger,
  );

  await assertRejects(
    () =>
      executor.execute({
        type: "request",
        requestId: "request-1",
        request: { method: "GET", url: "/health" },
      }),
    RuntimeError,
    "forwarding.outboundUrlAllowlist",
  );
});
