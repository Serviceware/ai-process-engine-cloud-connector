import { assertEquals, assertThrows } from "@std/assert";
import {
  combineConfig,
  loadEnvironmentConfig,
  parseVolumeConfig,
} from "./config.ts";
import { RuntimeError } from "./runtime-error.ts";

const requiredEnvironment = {
  CLOUD_CONNECTOR_HOST: "https://cloud.example",
  CLOUD_CONNECTOR_CLIENT_ID: "client-id",
  CLOUD_CONNECTOR_CLIENT_SECRET: "client-secret",
};

const minimalYaml = `
connection:
  websocketUrl: wss://cloud.example/connector/ws
forwarding:
  target: https://internal.example
`;

Deno.test("loadEnvironmentConfig keeps only credentials and resilience tuning", () => {
  const config = loadEnvironmentConfig(requiredEnvironment);

  assertEquals(config, {
    cloudConnectorHost: "https://cloud.example/",
    cloudConnectorClientId: "client-id",
    cloudConnectorClientSecret: "client-secret",
    reconnectInitialDelayMs: 1_000,
    reconnectMaxDelayMs: 30_000,
    connectTimeoutMs: 10_000,
    reconnectStableThresholdMs: 5_000,
    heartbeatTimeoutFactor: 3,
    tokenFetchTimeoutMs: 10_000,
    reconnectJitterRatio: 0.5,
    livenessStaleMs: 120_000,
  });
});

Deno.test("loadEnvironmentConfig requires Cloud host and credentials", () => {
  for (const missing of Object.keys(requiredEnvironment)) {
    const env = { ...requiredEnvironment } as Record<
      string,
      string | undefined
    >;
    delete env[missing];
    assertThrows(
      () => loadEnvironmentConfig(env),
      Error,
      missing,
    );
  }
});

Deno.test("loadEnvironmentConfig validates Cloud host and resilience values", () => {
  assertThrows(
    () =>
      loadEnvironmentConfig({
        ...requiredEnvironment,
        CLOUD_CONNECTOR_HOST: "wss://cloud.example",
      }),
    Error,
    "CLOUD_CONNECTOR_HOST must use one of these protocols: http:, https:",
  );

  for (const value of ["0", "-1", "1.5", "abc"]) {
    assertThrows(
      () =>
        loadEnvironmentConfig({
          ...requiredEnvironment,
          CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS: value,
        }),
      Error,
      "must be a positive integer",
    );
  }
});

Deno.test("loadEnvironmentConfig reads explicit resilience tuning", () => {
  const config = loadEnvironmentConfig({
    ...requiredEnvironment,
    CLOUD_CONNECTOR_CONNECT_TIMEOUT_SECONDS: "20",
    CLOUD_CONNECTOR_RECONNECT_INITIAL_SECONDS: "2",
    CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS: "9",
    CLOUD_CONNECTOR_RECONNECT_STABLE_SECONDS: "8",
    CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "0",
    CLOUD_CONNECTOR_TOKEN_TIMEOUT_SECONDS: "7",
    CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO: "0.25",
    CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS: "200",
  });

  assertEquals(config.connectTimeoutMs, 20_000);
  assertEquals(config.reconnectInitialDelayMs, 2_000);
  assertEquals(config.reconnectMaxDelayMs, 9_000);
  assertEquals(config.reconnectStableThresholdMs, 8_000);
  assertEquals(config.heartbeatTimeoutFactor, 0);
  assertEquals(config.tokenFetchTimeoutMs, 7_000);
  assertEquals(config.reconnectJitterRatio, 0.25);
  assertEquals(config.livenessStaleMs, 200_000);
});

Deno.test("loadEnvironmentConfig rejects invalid resilience ratios and factors", () => {
  for (const value of ["-0.1", "1.5", "abc"]) {
    assertThrows(
      () =>
        loadEnvironmentConfig({
          ...requiredEnvironment,
          CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO: value,
        }),
      Error,
      "must be a number between 0 and 1",
    );
  }
  assertThrows(
    () =>
      loadEnvironmentConfig({
        ...requiredEnvironment,
        CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "-1",
      }),
    Error,
    "must be a non-negative integer",
  );
});

Deno.test("parseVolumeConfig normalizes all operational YAML settings", () => {
  const config = parseVolumeConfig(`
connection:
  websocketUrl: " wss://cloud.example/connector/ws "
  heartbeatIntervalSeconds: 15
logging:
  level: debug
forwarding:
  target: https://internal.example
  outboundUrlAllowlist:
    - "^https://internal[.]example(?:/|$)"
  methods: [GET, POST]
  timeout: 5000
`);

  assertEquals(config, {
    connection: {
      websocketUrl: "wss://cloud.example/connector/ws",
      heartbeatIntervalMs: 15_000,
    },
    logging: { level: "debug" },
    forwarding: {
      target: "https://internal.example",
      outboundUrlAllowlist: ["^https://internal[.]example(?:/|$)"],
      methods: ["GET", "POST"],
      timeout: 5000,
      request: undefined,
      response: undefined,
    },
  });
});

Deno.test("parseVolumeConfig applies hot-reloadable defaults", () => {
  const config = parseVolumeConfig(minimalYaml);
  assertEquals(config.connection.heartbeatIntervalMs, 30_000);
  assertEquals(config.logging.level, "info");
  assertEquals(config.forwarding.outboundUrlAllowlist, []);
});

Deno.test("parseVolumeConfig rejects malformed, unknown, and removed config", () => {
  for (
    const yaml of [
      "not: [valid",
      "connection: {}\nforwarding:\n  target: https://internal.example",
      `${minimalYaml}\nunknown: true`,
      `${minimalYaml}\nlogging:\n  level: trace`,
      `${minimalYaml}\nforwarding:\n  target: https://internal.example\n  body: changed`,
    ]
  ) {
    assertThrows(() => parseVolumeConfig(yaml), RuntimeError);
  }
});

Deno.test("parseVolumeConfig validates the YAML outbound allowlist", () => {
  for (const value of ["{}", '[""]', "[42]"]) {
    assertThrows(
      () =>
        parseVolumeConfig(`
connection:
  websocketUrl: wss://cloud.example/ws
forwarding:
  target: https://internal.example
  outboundUrlAllowlist: ${value}
`),
      RuntimeError,
      "must be an array of non-empty strings",
    );
  }
  assertThrows(
    () =>
      parseVolumeConfig(`
connection:
  websocketUrl: wss://cloud.example/ws
forwarding:
  target: https://internal.example
  outboundUrlAllowlist: ["("]
`),
    RuntimeError,
    "is not a valid regular expression",
  );
});

Deno.test("combineConfig requires liveness to cover backoff and YAML heartbeat", () => {
  const shortLiveness = loadEnvironmentConfig({
    ...requiredEnvironment,
    CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS: "5",
    CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS: "10",
  });
  const longHeartbeat = parseVolumeConfig(`
connection:
  websocketUrl: wss://cloud.example/ws
  heartbeatIntervalSeconds: 20
forwarding:
  target: https://internal.example
`);

  assertThrows(
    () => combineConfig(shortLiveness, longHeartbeat),
    Error,
    "must be greater than both",
  );
});
