import { assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "./config.ts";

Deno.test("loadConfig uses documented defaults", () => {
  const config = loadConfig({});

  assertEquals(config, {
    host: "0.0.0.0",
    port: 8080,
    websocketUrl: undefined,
    cloudConnectorHost: undefined,
    cloudConnectorClientId: undefined,
    cloudConnectorClientSecret: undefined,
    forwardingConfigFile: "forwarding.yml",
    heartbeatIntervalMs: 30_000,
    reconnectInitialDelayMs: 1_000,
    reconnectMaxDelayMs: 30_000,
    connectTimeoutMs: 10_000,
    reconnectStableThresholdMs: 5_000,
    heartbeatTimeoutFactor: 3,
    tokenFetchTimeoutMs: 10_000,
    reconnectJitterRatio: 0.5,
    livenessStaleMs: 120_000,
    logLevel: "info",
    outboundUrlAllowlist: [],
  });
});

Deno.test("loadConfig reads explicit values and trims optional paths", () => {
  const config = loadConfig({
    CONNECTOR_HOST: "127.0.0.1",
    CONNECTOR_PORT: "9090",
    CLOUD_CONNECTOR_WS_URL: " wss://cloud.example/ws ",
    CLOUD_CONNECTOR_HOST: " https://cloud.example ",
    CLOUD_CONNECTOR_CLIENT_ID: " client-id ",
    CLOUD_CONNECTOR_CLIENT_SECRET: " client-secret ",
    CLOUD_CONNECTOR_FORWARDING_CONFIG: " config/forwarding.yml ",
    CLOUD_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS: "5",
    CLOUD_CONNECTOR_RECONNECT_INITIAL_SECONDS: "2",
    CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS: "9",
    CLOUD_CONNECTOR_LOG_LEVEL: " DEBUG ",
    OUTBOUND_URL_ALLOWLIST: '["^https://api[.]example[.]com(?:/|$)", ".*"]',
  });

  assertEquals(config.host, "127.0.0.1");
  assertEquals(config.port, 9090);
  assertEquals(config.websocketUrl, "wss://cloud.example/ws");
  assertEquals(config.cloudConnectorHost, "https://cloud.example/");
  assertEquals(config.cloudConnectorClientId, "client-id");
  assertEquals(config.cloudConnectorClientSecret, "client-secret");
  assertEquals(config.forwardingConfigFile, "config/forwarding.yml");
  assertEquals(config.heartbeatIntervalMs, 5_000);
  assertEquals(config.reconnectInitialDelayMs, 2_000);
  assertEquals(config.reconnectMaxDelayMs, 9_000);
  assertEquals(config.logLevel, "debug");
  assertEquals(config.outboundUrlAllowlist, [
    "^https://api[.]example[.]com(?:/|$)",
    ".*",
  ]);
});

Deno.test("loadConfig rejects malformed outbound URL allowlists", () => {
  for (
    const value of [
      "not-json",
      "{}",
      '[""]',
      "[42]",
    ]
  ) {
    assertThrows(
      () => loadConfig({ OUTBOUND_URL_ALLOWLIST: value }),
      Error,
      "OUTBOUND_URL_ALLOWLIST must be a JSON array",
    );
  }

  assertThrows(
    () => loadConfig({ OUTBOUND_URL_ALLOWLIST: '["("]' }),
    Error,
    "OUTBOUND_URL_ALLOWLIST[0] is not a valid regular expression",
  );
});

Deno.test("loadConfig rejects invalid URL values", () => {
  assertThrows(
    () => loadConfig({ CLOUD_CONNECTOR_WS_URL: "cloud.example/ws" }),
    Error,
    "CLOUD_CONNECTOR_WS_URL must be a valid absolute URL",
  );
  assertThrows(
    () => loadConfig({ CLOUD_CONNECTOR_HOST: "wss://cloud.example" }),
    Error,
    "CLOUD_CONNECTOR_HOST must use one of these protocols: http:, https:",
  );
});

Deno.test("loadConfig requires authentication settings when cloud auth is used", () => {
  assertThrows(
    () => loadConfig({ CLOUD_CONNECTOR_WS_URL: "wss://cloud.example/ws" }),
    Error,
    "Edge Connector authentication requires CLOUD_CONNECTOR_HOST, CLOUD_CONNECTOR_CLIENT_ID, CLOUD_CONNECTOR_CLIENT_SECRET",
  );
});

Deno.test("loadConfig rejects non-positive and non-integer numbers", () => {
  for (const value of ["0", "-1", "1.5", "abc"]) {
    assertThrows(
      () => loadConfig({ CONNECTOR_PORT: value }),
      Error,
      "CONNECTOR_PORT must be a positive integer",
    );
  }
});

Deno.test("loadConfig reads the resilience tuning settings", () => {
  const config = loadConfig({
    CLOUD_CONNECTOR_CONNECT_TIMEOUT_SECONDS: "20",
    CLOUD_CONNECTOR_RECONNECT_STABLE_SECONDS: "8",
    CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "5",
    CLOUD_CONNECTOR_TOKEN_TIMEOUT_SECONDS: "7",
    CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO: "0.25",
    CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS: "30",
    CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS: "200",
  });

  assertEquals(config.connectTimeoutMs, 20_000);
  assertEquals(config.reconnectStableThresholdMs, 8_000);
  assertEquals(config.heartbeatTimeoutFactor, 5);
  assertEquals(config.tokenFetchTimeoutMs, 7_000);
  assertEquals(config.reconnectJitterRatio, 0.25);
  assertEquals(config.livenessStaleMs, 200_000);
});

Deno.test("loadConfig allows disabling the heartbeat watchdog with factor 0", () => {
  const config = loadConfig({ CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "0" });
  assertEquals(config.heartbeatTimeoutFactor, 0);
});

Deno.test("loadConfig rejects a jitter ratio outside 0..1", () => {
  for (const value of ["-0.1", "1.5", "abc"]) {
    assertThrows(
      () => loadConfig({ CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO: value }),
      Error,
      "CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO must be a number between 0 and 1",
    );
  }
});

Deno.test("loadConfig rejects a negative heartbeat timeout factor", () => {
  assertThrows(
    () => loadConfig({ CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "-1" }),
    Error,
    "CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR must be a non-negative integer",
  );
});

Deno.test("loadConfig rejects invalid log levels", () => {
  assertThrows(
    () => loadConfig({ CLOUD_CONNECTOR_LOG_LEVEL: "trace" }),
    Error,
    "CLOUD_CONNECTOR_LOG_LEVEL must be one of: error, warn, info, debug",
  );
});

Deno.test("loadConfig requires the liveness window to exceed the max backoff", () => {
  assertThrows(
    () =>
      loadConfig({
        CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS: "120",
        CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS: "60",
      }),
    Error,
    "CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS must be greater than",
  );
});

Deno.test("loadConfig requires the liveness window to exceed the heartbeat interval", () => {
  assertThrows(
    () =>
      loadConfig({
        CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS: "5",
        CLOUD_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS: "200",
        CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS: "120",
      }),
    Error,
    "CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS must be greater than",
  );
});
