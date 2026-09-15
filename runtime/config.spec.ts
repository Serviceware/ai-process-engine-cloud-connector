import { assertEquals, assertThrows } from "@std/assert";
import {
  combineConfig,
  deriveWebSocketUrl,
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
connection: {}
forwarding:
  - target: ^https://internal[.]example(?:/.*)?$
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
    maxResponseBodyBytes: 10_485_760,
    maxConcurrentRequests: 100,
    drainTimeoutMs: 30_000,
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
    CLOUD_CONNECTOR_MAX_RESPONSE_BODY_BYTES: "2048",
    CLOUD_CONNECTOR_MAX_CONCURRENT_REQUESTS: "12",
    CLOUD_CONNECTOR_DRAIN_TIMEOUT_SECONDS: "4",
  });

  assertEquals(config.connectTimeoutMs, 20_000);
  assertEquals(config.reconnectInitialDelayMs, 2_000);
  assertEquals(config.reconnectMaxDelayMs, 9_000);
  assertEquals(config.reconnectStableThresholdMs, 8_000);
  assertEquals(config.heartbeatTimeoutFactor, 0);
  assertEquals(config.tokenFetchTimeoutMs, 7_000);
  assertEquals(config.reconnectJitterRatio, 0.25);
  assertEquals(config.livenessStaleMs, 200_000);
  assertEquals(config.maxResponseBodyBytes, 2_048);
  assertEquals(config.maxConcurrentRequests, 12);
  assertEquals(config.drainTimeoutMs, 4_000);
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
  purpose: inventory
  heartbeatIntervalSeconds: 15
logging:
  level: debug
forwarding:
  - target: "^https://internal[.]example(?:/.*)?$"
    methods: [GET, POST]
    timeout: 5000
`);

  assertEquals(config, {
    connection: {
      purpose: "inventory",
      heartbeatIntervalMs: 15_000,
    },
    logging: { level: "debug" },
    forwarding: [{
      target: "^https://internal[.]example(?:/.*)?$",
      methods: ["GET", "POST"],
      timeout: 5000,
      request: undefined,
      response: undefined,
    }],
  });
});

Deno.test("parseVolumeConfig applies hot-reloadable defaults", () => {
  const config = parseVolumeConfig(minimalYaml);
  assertEquals(config.connection.purpose, "main");
  assertEquals(config.connection.heartbeatIntervalMs, 30_000);
  assertEquals(config.logging.level, "info");
  assertEquals(config.forwarding.length, 1);
});

Deno.test("combineConfig derives the WebSocket endpoint from host and purpose", () => {
  const config = combineConfig(
    loadEnvironmentConfig(requiredEnvironment),
    parseVolumeConfig(minimalYaml),
  );
  assertEquals(
    config.websocketUrl,
    "wss://cloud.example/configuration-store/api/v1/connector/main/connect",
  );
  assertEquals(
    deriveWebSocketUrl("http://localhost:8000/base/?old=true", "inventory v2"),
    "ws://localhost:8000/configuration-store/api/v1/connector/inventory%20v2/connect",
  );
});

Deno.test("parseVolumeConfig rejects malformed, unknown, and removed config", () => {
  for (
    const yaml of [
      "not: [valid",
      "connection: {}\nforwarding: {}",
      `${minimalYaml}\nunknown: true`,
      `${minimalYaml}\nlogging:\n  level: trace`,
      "connection:\n  purpose: '  '\nforwarding:\n  - target: https://internal.example",
      `${minimalYaml}\nforwarding:\n  - target: https://internal.example\n    body: changed`,
    ]
  ) {
    assertThrows(() => parseVolumeConfig(yaml), RuntimeError);
  }
});

Deno.test("parseVolumeConfig validates forwarding rule arrays and target regexes", () => {
  for (const value of ["{}", "[]", "[42]"]) {
    assertThrows(
      () =>
        parseVolumeConfig(`
connection: {}
forwarding: ${value}
`),
      RuntimeError,
      "forwarding",
    );
  }
  assertThrows(
    () =>
      parseVolumeConfig(`
connection: {}
forwarding:
  - target: "("
`),
    RuntimeError,
    "is not a valid regular expression",
  );
  assertThrows(
    () =>
      parseVolumeConfig(`
connection: {}
forwarding:
  - target: https://internal[.]example
`),
    RuntimeError,
    "must start with ^ and end with $",
  );
  assertThrows(
    () =>
      parseVolumeConfig(`
connection: {}
forwarding:
  - target: ^https://internal[.]example(/.*)*(/api)$
`),
    RuntimeError,
    "excessive backtracking",
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
  heartbeatIntervalSeconds: 20
forwarding:
  - target: ^https://internal[.]example(?:/.*)?$
`);

  assertThrows(
    () => combineConfig(shortLiveness, longHeartbeat),
    Error,
    "must be greater than both",
  );
});

Deno.test("combineConfig rejects a peer-silence window shorter than the cloud heartbeat", () => {
  const fastHeartbeat = parseVolumeConfig(`
connection:
  heartbeatIntervalSeconds: 5
forwarding:
  - target: ^https://internal[.]example(?:/.*)?$
`);
  assertThrows(
    () =>
      combineConfig(loadEnvironmentConfig(requiredEnvironment), fastHeartbeat),
    Error,
    "30-second Serviceware Cloud heartbeat interval",
  );
  const watchdogDisabled = loadEnvironmentConfig({
    ...requiredEnvironment,
    CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "0",
  });
  assertEquals(
    combineConfig(watchdogDisabled, fastHeartbeat).heartbeatIntervalMs,
    5_000,
  );
});
