import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  combineConfig,
  deriveWebSocketUrl,
  loadEnvironmentConfig,
  loadVolumeConfig,
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
    const env = { ...requiredEnvironment } as Record<string, string | undefined>;
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
  ).toThrow("CLOUD_CONNECTOR_HOST must use one of these protocols: http:, https:");

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
  const config = combineConfig(loadEnvironmentConfig(requiredEnvironment), parseVolumeConfig(minimalYaml));
  expect(config.websocketUrl).toStrictEqual("wss://cloud.example/configuration-store/api/v1/connector/main/connect");
  expect(deriveWebSocketUrl("http://localhost:8000/base/?old=true", "inventory v2")).toStrictEqual(
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

  expect(() => combineConfig(shortLiveness, longHeartbeat)).toThrow("must be greater than both");
});

test("combineConfig rejects a peer-silence window shorter than the cloud heartbeat", () => {
  const fastHeartbeat = parseVolumeConfig(`
connection:
  heartbeatIntervalSeconds: 5
forwarding:
  - target: ^https://internal[.]example(?:/.*)?$
`);
  expect(() => combineConfig(loadEnvironmentConfig(requiredEnvironment), fastHeartbeat)).toThrow(
    "30-second Serviceware Cloud heartbeat interval",
  );
  const watchdogDisabled = loadEnvironmentConfig({
    ...requiredEnvironment,
    CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "0",
  });
  expect(combineConfig(watchdogDisabled, fastHeartbeat).heartbeatIntervalMs).toStrictEqual(5_000);
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
    expect({ source, ms: config.connection.heartbeatIntervalMs }).toStrictEqual({
      source,
      ms: seconds * 1000,
    });
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

function parseRule(rule: string) {
  return parseVolumeConfig(`connection: {}\nforwarding:\n  - target: ^https://internal[.]example(?:/.*)?$\n${rule}\n`);
}

function parseRuleWithTarget(target: string) {
  return parseVolumeConfig(`connection: {}\nforwarding:\n  - target: '${target}'\n`);
}

function targetVerdict(target: string): string {
  try {
    parseRuleWithTarget(target);
    return "accepted";
  } catch (error) {
    const message = (error as Error).message;
    return message.includes("excessive backtracking") ? "rejected: excessive backtracking" : `rejected: ${message}`;
  }
}

function oauth2Rule(issuer: string): string {
  return `    request:
      auth:
        type: oauth2
        issuer: ${issuer}
        clientId: connector
        clientSecret: secret`;
}

test("parseVolumeConfig rejects OAuth2 issuers that are not absolute http(s) URLs", () => {
  expect(() => parseRule(oauth2Rule("ftp://idp.example/token"))).toThrow(
    "forwarding[0].request.auth.issuer must use one of these protocols: http:, https:",
  );
  expect(() => parseRule(oauth2Rule("relative/token"))).toThrow(
    "forwarding[0].request.auth.issuer must be a valid absolute URL",
  );
  expect(parseRule(oauth2Rule("https://idp.example/token")).forwarding[0].request?.auth).toMatchObject({
    issuer: "https://idp.example/token",
  });
});

test("parseVolumeConfig validates authentication shapes and interpolation", () => {
  const cases: [string, string][] = [
    ["    request:\n      auth:\n        type: digest", "request.auth.type must be one of: basic, bearer, oauth2"],
    ["    request:\n      auth:\n        token: abc", "request.auth.type must be a string"],
    ["    request:\n      auth: bearer", "request.auth must be an object"],
    ["    request:\n      auth:\n        type: bearer\n        token: '  '", "request.auth.token must not be empty"],
    [
      "    request:\n      auth:\n        type: bearer\n        token: '{{ context.requestId }}'",
      "request.auth.token contains an unsupported interpolation value",
    ],
    [
      "    request:\n      auth:\n        type: bearer\n        token: '{{ env.TOKEN'",
      "request.auth.token contains malformed interpolation syntax",
    ],
    [
      "    request:\n      auth:\n        type: oauth2\n        issuer: https://idp.example/t\n        clientId: id\n        clientSecret: s\n        scope: ''",
      "request.auth.scope must not be empty",
    ],
    [
      "    request:\n      auth:\n        type: oauth2\n        issuer: https://idp.example/t\n        clientId: id\n        clientSecret: s\n        audience: x",
      "request.auth.audience is not supported",
    ],
  ];
  for (const [rule, message] of cases) {
    expect(() => parseRule(rule)).toThrow(message);
  }

  const accepted = parseRule(
    "    request:\n      auth:\n        type: bearer\n        token: '{{ env.API_TOKEN }}-{{env:SUFFIX}}'",
  );
  expect(accepted.forwarding[0].request?.auth).toStrictEqual({
    type: "bearer",
    token: "{{ env.API_TOKEN }}-{{env:SUFFIX}}",
  });
});

test("parseVolumeConfig validates request.pathPrefix", () => {
  for (const prefix of ["api", "//api", "/api?x=1", "/api#frag", "/{{ env.PREFIX }}", "/api}}"]) {
    expect(() => parseRule(`    request:\n      pathPrefix: '${prefix}'`)).toThrow(
      "request.pathPrefix must be an absolute path without query or fragment",
    );
  }
  expect(() => parseRule("    request:\n      pathPrefix: 5")).toThrow("request.pathPrefix must be a string");
  expect(parseRule("    request:\n      pathPrefix: /api/v1/").forwarding[0].request?.pathPrefix).toStrictEqual(
    "/api/v1/",
  );
});

test("parseVolumeConfig validates request and response sections", () => {
  expect(() => parseRule("    request:\n      forwardIncomingCredentials: 'yes'")).toThrow(
    "request.forwardIncomingCredentials must be a boolean",
  );
  expect(() => parseRule("    request:\n      body: x")).toThrow("request.body is not supported");
  expect(() => parseRule("    request: []")).toThrow("request must be an object");
  expect(() => parseRule("    response:\n      pathPrefix: /x")).toThrow("response.pathPrefix is not supported");
  expect(() => parseRule("    response: text")).toThrow("response must be an object");
  expect(parseRule("    request:\n      forwardIncomingCredentials: true").forwarding[0].request).toStrictEqual({
    forwardIncomingCredentials: true,
  });
});

test("parseVolumeConfig validates header add, set, and remove", () => {
  const headers = (body: string) => `    request:\n      headers:\n${body}`;
  expect(() => parseRule(headers("        add: [x-a]"))).toThrow("request.headers.add must be an object");
  expect(() => parseRule(headers("        set:\n          x-a: 1"))).toThrow(
    "request.headers.set.x-a must be a string",
  );
  expect(() => parseRule(headers("        add:\n          x-a: [one]"))).toThrow(
    "request.headers.add.x-a must be a string",
  );
  expect(() => parseRule(headers("        remove: x-a"))).toThrow("request.headers.remove must be an array of strings");
  expect(() => parseRule(headers("        remove: [1]"))).toThrow("request.headers.remove must be an array of strings");
  expect(() => parseRule(headers("        replace: {}"))).toThrow("request.headers.replace is not supported");
  expect(() => parseRule(headers("        set:\n          x-a: '{{ env.A'"))).toThrow(
    "request.headers.set.x-a contains malformed interpolation syntax",
  );
  expect(() => parseRule(headers("        set:\n          x-a: '{{ request.url }}'"))).toThrow(
    "request.headers.set.x-a contains an unsupported interpolation value",
  );
  expect(() => parseRule(`    response:\n      headers:\n        add:\n          x-a: '{{ context.nope }}'`)).toThrow(
    "response.headers.add.x-a contains an unsupported interpolation value",
  );

  const accepted = parseRule(
    headers(
      "        set:\n          x-id: '{{ context.requestId }}'\n          x-at: '{{ context.startedAt }}'\n          x-env: '{{ env:A }}'\n        remove: [server]",
    ),
  );
  expect(accepted.forwarding[0].request?.headers?.remove).toStrictEqual(["server"]);
});

test("parseVolumeConfig validates methods", () => {
  for (const methods of ["[get]", "[TRACE]", "[GET, GET]", "GET", "[1]"]) {
    expect(() => parseRule(`    methods: ${methods}`)).toThrow(
      "forwarding[0].methods must be an array of supported uppercase HTTP methods",
    );
  }
  expect(parseRule("    methods: [GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS]").forwarding[0].methods).toStrictEqual([
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ]);
  expect(parseRule("    methods: []").forwarding[0].methods).toStrictEqual([]);
  expect(parseRule("").forwarding[0].methods).toBeUndefined();
});

test("parseVolumeConfig bounds the forwarding timeout to 1000..300000 integer milliseconds", () => {
  for (const timeout of ["999", "300001", "1500.5", "'5000'", "0", "-1000"]) {
    expect(() => parseRule(`    timeout: ${timeout}`)).toThrow(
      "forwarding[0].timeout must be an integer between 1000 and 300000",
    );
  }
  expect(parseRule("    timeout: 1000").forwarding[0].timeout).toStrictEqual(1000);
  expect(parseRule("    timeout: 300000").forwarding[0].timeout).toStrictEqual(300_000);
  expect(parseRule("").forwarding[0].timeout).toBeUndefined();
});

test("parseVolumeConfig trims targets and rejects blank or non-string targets", () => {
  expect(parseRuleWithTarget("  ^https://a[.]example/.*$  ").forwarding[0].target).toStrictEqual(
    "^https://a[.]example/.*$",
  );
  expect(() => parseRuleWithTarget("   ")).toThrow("forwarding[0].target must not be empty");
  expect(() => parseVolumeConfig("connection: {}\nforwarding:\n  - target: 5\n")).toThrow(
    "forwarding[0].target must be a string",
  );
  expect(() => parseVolumeConfig("connection: {}\nforwarding:\n  - methods: [GET]\n")).toThrow(
    "forwarding[0].target must be a string",
  );
  expect(() => parseRuleWithTarget("^https://a[.]example")).toThrow("must start with ^ and end with $");
  expect(() => parseRuleWithTarget("https://a[.]example$")).toThrow("must start with ^ and end with $");
});

test("parseVolumeConfig rejects target regexes with nested or ambiguous repetition", () => {
  const targets = ["^(a+)+$", "^(a|b)*$", "^(?:a|b)+$", "^(a{2,})+$", "^https://a/(.*)*$", "^(a?)+$"];
  expect(targets.map(targetVerdict)).toStrictEqual(targets.map(() => "rejected: excessive backtracking"));
});

test("parseVolumeConfig accepts target regexes without ambiguous repetition", () => {
  const targets = [
    "^https://a[.]example(?:/.*)?$",
    "^https://a[.]example/(?:v1|v2)/.*$",
    "^https://a[.]example/(?:v1|v2)?$",
    "^https://a[.]example/[+*]+$",
    "^https://a[.]example/\\+\\*$",
    "^https://a[.]example/(a{1,3}){2}$",
    "^https://a[.]example/[a-z]{2,}$",
  ];
  expect(targets.map(targetVerdict)).toStrictEqual(targets.map(() => "accepted"));
});

test("parseVolumeConfig validates connection and logging sections", () => {
  const withConnection = (connection: string) =>
    `connection:\n${connection}\nforwarding:\n  - target: ^https://a[.]example$\n`;
  for (const value of ["0", "-5", "1.5", "'30'", "true"]) {
    expect(() => parseVolumeConfig(withConnection(`  heartbeatIntervalSeconds: ${value}`))).toThrow(
      "connection.heartbeatIntervalSeconds must be a positive integer",
    );
  }
  expect(() => parseVolumeConfig(withConnection("  purpose: 5"))).toThrow("connection.purpose must be a string");
  expect(() => parseVolumeConfig(withConnection("  timeout: 5"))).toThrow("connection.timeout is not supported");
  expect(parseVolumeConfig(withConnection("  purpose: '  inventory  '")).connection.purpose).toStrictEqual("inventory");
  expect(() => parseVolumeConfig("forwarding:\n  - target: ^https://a[.]example$\n")).toThrow(
    "connection must be an object",
  );
  expect(() => parseVolumeConfig(`${minimalYaml}\nlogging: debug`)).toThrow("logging must be an object");
  expect(() => parseVolumeConfig(`${minimalYaml}\nlogging:\n  level: 3`)).toThrow("logging.level must be one of");
  expect(() => parseVolumeConfig(`${minimalYaml}\nlogging:\n  format: json`)).toThrow(
    "logging.format is not supported",
  );
  for (const level of ["error", "warn", "info", "debug"]) {
    expect(parseVolumeConfig(`${minimalYaml}\nlogging:\n  level: ${level}`).logging.level).toStrictEqual(level);
  }
  expect(parseVolumeConfig(`${minimalYaml}\nlogging: {}`).logging.level).toStrictEqual("info");
});

test("parseVolumeConfig reports the config path in YAML and validation errors", () => {
  expect(() => parseVolumeConfig("not: [valid", "/config/x.yml")).toThrow(
    expect.objectContaining({ code: "YAML_PARSE_ERROR", message: expect.stringContaining("/config/x.yml") }),
  );
  expect(() => parseVolumeConfig("connection: {}\nforwarding: []", "/config/x.yml")).toThrow(
    expect.objectContaining({
      code: "CONFIG_ERROR",
      message: "Invalid Cloud Connector YAML config at /config/x.yml: forwarding must be a non-empty array of rules",
    }),
  );
});

test("loadVolumeConfig reads a file and reports unreadable paths with cause", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-connector-config-"));
  try {
    const path = join(directory, "cloud-connector.yml");
    await writeFile(path, minimalYaml);
    expect((await loadVolumeConfig(path)).forwarding.length).toStrictEqual(1);

    const missing = join(directory, "missing.yml");
    await expect(loadVolumeConfig(missing)).rejects.toMatchObject({
      name: "RuntimeError",
      code: "CONFIG_ERROR",
      message: `Cannot read required Cloud Connector YAML config at ${missing}`,
      cause: expect.objectContaining({ code: "ENOENT" }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadEnvironmentConfig trims values, treats blanks as unset, and accepts ratio bounds", () => {
  const config = loadEnvironmentConfig({
    ...requiredEnvironment,
    CLOUD_CONNECTOR_CLIENT_ID: "  id  ",
    CLOUD_CONNECTOR_CLIENT_SECRET: "  secret  ",
    CLOUD_CONNECTOR_CONNECT_TIMEOUT_SECONDS: "  ",
    CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO: "",
    CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: " ",
    CLOUD_CONNECTOR_DRAIN_TIMEOUT_SECONDS: " 7 ",
  });
  expect(config.cloudConnectorClientId).toStrictEqual("id");
  expect(config.cloudConnectorClientSecret).toStrictEqual("secret");
  expect(config.connectTimeoutMs).toStrictEqual(10_000);
  expect(config.reconnectJitterRatio).toStrictEqual(0.5);
  expect(config.heartbeatTimeoutFactor).toStrictEqual(3);
  expect(config.drainTimeoutMs).toStrictEqual(7_000);
  for (const [value, expected] of [
    ["0", 0],
    ["1", 1],
  ] as const) {
    expect(
      loadEnvironmentConfig({ ...requiredEnvironment, CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO: value })
        .reconnectJitterRatio,
    ).toStrictEqual(expected);
  }
});

test("loadEnvironmentConfig rejects blank and credential-bearing Cloud host values", () => {
  for (const key of ["CLOUD_CONNECTOR_HOST", "CLOUD_CONNECTOR_CLIENT_ID", "CLOUD_CONNECTOR_CLIENT_SECRET"]) {
    expect(() => loadEnvironmentConfig({ ...requiredEnvironment, [key]: "   " })).toThrow(`${key} is required`);
  }
  expect(() => loadEnvironmentConfig({ ...requiredEnvironment, CLOUD_CONNECTOR_HOST: "not a url" })).toThrow(
    "CLOUD_CONNECTOR_HOST must be a valid absolute URL",
  );
  expect(() =>
    loadEnvironmentConfig({ ...requiredEnvironment, CLOUD_CONNECTOR_HOST: "https://user:pw@cloud.example" }),
  ).toThrow("CLOUD_CONNECTOR_HOST must not contain credentials");
  expect(() =>
    loadEnvironmentConfig({ ...requiredEnvironment, CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "1.5" }),
  ).toThrow("must be a non-negative integer");
});
