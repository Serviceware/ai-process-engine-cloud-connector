import { expect, test } from "vitest";
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

test("loadEnvironmentConfig keeps only credentials and resilience tuning", () => {
  const config = loadEnvironmentConfig(requiredEnvironment);

  expect(config).toStrictEqual({
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

test("loadEnvironmentConfig requires Cloud host and credentials", () => {
  for (const missing of Object.keys(requiredEnvironment)) {
    const env = { ...requiredEnvironment } as Record<
      string,
      string | undefined
    >;
    delete env[missing];
    expect(() => loadEnvironmentConfig(env)).toThrow(missing);
  }
});

test("loadEnvironmentConfig validates Cloud host and resilience values", () => {
  expect(() =>
    loadEnvironmentConfig({
      ...requiredEnvironment,
      CLOUD_CONNECTOR_HOST: "wss://cloud.example",
    }),
  ).toThrow(
    "CLOUD_CONNECTOR_HOST must use one of these protocols: http:, https:",
  );

  for (const value of ["0", "-1", "1.5", "abc"]) {
    expect(() =>
      loadEnvironmentConfig({
        ...requiredEnvironment,
        CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS: value,
      }),
    ).toThrow("must be a positive integer");
  }
});

test("loadEnvironmentConfig reads explicit resilience tuning", () => {
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

  expect(config.connectTimeoutMs).toStrictEqual(20_000);
  expect(config.reconnectInitialDelayMs).toStrictEqual(2_000);
  expect(config.reconnectMaxDelayMs).toStrictEqual(9_000);
  expect(config.reconnectStableThresholdMs).toStrictEqual(8_000);
  expect(config.heartbeatTimeoutFactor).toStrictEqual(0);
  expect(config.tokenFetchTimeoutMs).toStrictEqual(7_000);
  expect(config.reconnectJitterRatio).toStrictEqual(0.25);
  expect(config.livenessStaleMs).toStrictEqual(200_000);
  expect(config.maxResponseBodyBytes).toStrictEqual(2_048);
  expect(config.maxConcurrentRequests).toStrictEqual(12);
  expect(config.drainTimeoutMs).toStrictEqual(4_000);
});

test("loadEnvironmentConfig rejects invalid resilience ratios and factors", () => {
  for (const value of ["-0.1", "1.5", "abc"]) {
    expect(() =>
      loadEnvironmentConfig({
        ...requiredEnvironment,
        CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO: value,
      }),
    ).toThrow("must be a number between 0 and 1");
  }
  expect(() =>
    loadEnvironmentConfig({
      ...requiredEnvironment,
      CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "-1",
    }),
  ).toThrow("must be a non-negative integer");
});

test("parseVolumeConfig normalizes all operational YAML settings", () => {
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

  expect(config).toStrictEqual({
    connection: {
      purpose: "inventory",
      heartbeatIntervalMs: 15_000,
    },
    logging: { level: "debug" },
    forwarding: [
      {
        target: "^https://internal[.]example(?:/.*)?$",
        methods: ["GET", "POST"],
        timeout: 5000,
        request: undefined,
        response: undefined,
      },
    ],
  });
});

test("parseVolumeConfig applies hot-reloadable defaults", () => {
  const config = parseVolumeConfig(minimalYaml);
  expect(config.connection.purpose).toStrictEqual("main");
  expect(config.connection.heartbeatIntervalMs).toStrictEqual(30_000);
  expect(config.logging.level).toStrictEqual("info");
  expect(config.forwarding.length).toStrictEqual(1);
});

test("combineConfig derives the WebSocket endpoint from host and purpose", () => {
  const config = combineConfig(
    loadEnvironmentConfig(requiredEnvironment),
    parseVolumeConfig(minimalYaml),
  );
  expect(config.websocketUrl).toStrictEqual(
    "wss://cloud.example/configuration-store/api/v1/connector/main/connect",
  );
  expect(
    deriveWebSocketUrl("http://localhost:8000/base/?old=true", "inventory v2"),
  ).toStrictEqual(
    "ws://localhost:8000/configuration-store/api/v1/connector/inventory%20v2/connect",
  );
});

test("parseVolumeConfig resolves YAML merge keys", () => {
  const config = parseVolumeConfig(`
connection: {}
forwarding:
  - &internal
    target: ^https://internal[.]example(?:/.*)?$
    methods: [GET]
  - <<: *internal
    target: ^https://other[.]example(?:/.*)?$
`);

  expect(config.forwarding[1]).toMatchObject({
    target: "^https://other[.]example(?:/.*)?$",
    methods: ["GET"],
  });
});

test("parseVolumeConfig rejects malformed, unknown, and removed config", () => {
  for (const yaml of [
    "not: [valid",
    "connection: {}\nforwarding: {}",
    `${minimalYaml}\nunknown: true`,
    `${minimalYaml}\nlogging:\n  level: trace`,
    "connection:\n  purpose: '  '\nforwarding:\n  - target: https://internal.example",
    `${minimalYaml}\nforwarding:\n  - target: https://internal.example\n    body: changed`,
  ]) {
    expect(() => parseVolumeConfig(yaml)).toThrow(RuntimeError);
  }
});

test("parseVolumeConfig validates forwarding rule arrays and target regexes", () => {
  for (const value of ["{}", "[]", "[42]"]) {
    expect(() =>
      parseVolumeConfig(`
connection: {}
forwarding: ${value}
`),
    ).toThrow(
      expect.objectContaining({
        name: "RuntimeError",
        message: expect.stringContaining("forwarding"),
      }),
    );
  }
  expect(() =>
    parseVolumeConfig(`
connection: {}
forwarding:
  - target: "("
`),
  ).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("is not a valid regular expression"),
    }),
  );
  expect(() =>
    parseVolumeConfig(`
connection: {}
forwarding:
  - target: https://internal[.]example
`),
  ).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("must start with ^ and end with $"),
    }),
  );
  expect(() =>
    parseVolumeConfig(`
connection: {}
forwarding:
  - target: ^https://internal[.]example(/.*)*(/api)$
`),
  ).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("excessive backtracking"),
    }),
  );
});

test("combineConfig requires liveness to cover backoff and YAML heartbeat", () => {
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

  expect(() => combineConfig(shortLiveness, longHeartbeat)).toThrow(
    "must be greater than both",
  );
});

test("combineConfig rejects a peer-silence window shorter than the cloud heartbeat", () => {
  const fastHeartbeat = parseVolumeConfig(`
connection:
  heartbeatIntervalSeconds: 5
forwarding:
  - target: ^https://internal[.]example(?:/.*)?$
`);
  expect(() =>
    combineConfig(loadEnvironmentConfig(requiredEnvironment), fastHeartbeat),
  ).toThrow("30-second Serviceware Cloud heartbeat interval");
  const watchdogDisabled = loadEnvironmentConfig({
    ...requiredEnvironment,
    CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "0",
  });
  expect(
    combineConfig(watchdogDisabled, fastHeartbeat).heartbeatIntervalMs,
  ).toStrictEqual(5_000);
});

test("parseVolumeConfig keeps YAML 1.1 integer forms", () => {
  for (const [source, seconds] of [
    ["30_000", 30_000],
    ["010", 8],
    ["0b11", 3],
    ["0x1_F", 31],
    ["30", 30],
    ["0x1E", 30],
  ] as const) {
    const config = parseVolumeConfig(`
connection:
  heartbeatIntervalSeconds: ${source}
forwarding:
  - target: ^https://internal[.]example(?:/.*)?$
`);
    expect({ source, ms: config.connection.heartbeatIntervalMs }).toStrictEqual(
      {
        source,
        ms: seconds * 1000,
      },
    );
  }
});

test("parseVolumeConfig keeps leading-zero decimals and 0o octal as strings", () => {
  const config = parseVolumeConfig(`
connection: {}
forwarding:
  - target: ^https://internal[.]example(?:/.*)?$
    request:
      headers:
        set:
          x-window: 12:30
          x-start: 10:00:15
          x-suffix: 1_
          x-binary: 0b_
          x-leading-zero: 08
          x-octal: 0o12
`);

  expect(config.forwarding[0].request?.headers?.set).toStrictEqual({
    "x-window": "12:30",
    "x-start": "10:00:15",
    "x-suffix": "1_",
    "x-binary": "0b_",
    "x-leading-zero": "08",
    "x-octal": "0o12",
  });
});

test("parseVolumeConfig rejects OAuth2 issuers with credentials", () => {
  expect(() =>
    parseVolumeConfig(`
connection: {}
forwarding:
  - target: ^https://internal[.]example(?:/.*)?$
    request:
      auth:
        type: oauth2
        issuer: https://user:secret@idp.example/token
        clientId: connector
        clientSecret: secret
`),
  ).toThrow("forwarding[0].request.auth.issuer must not contain credentials");
});
