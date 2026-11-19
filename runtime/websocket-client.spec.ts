import { expect, test, vi } from "vitest";
import type { ConnectorConfig } from "./config.ts";
import { ConnectorRuntime, type ProtocolExecutor } from "./connector.ts";
import { createLogger } from "./logger.ts";
import { createRuntimeStatus } from "./runtime-status.ts";
import { computeBackoffDelay, delay, ReloadableWebSocketClient, runCloudWebSocketClient } from "./websocket-client.ts";

const baseConfig: ConnectorConfig = {
  websocketUrl: "wss://cloud.example/ws",
  cloudConnectorHost: "https://cloud.example/",
  cloudConnectorClientId: "client-id",
  cloudConnectorClientSecret: "client-secret",
  heartbeatIntervalMs: 1,
  reconnectInitialDelayMs: 1,
  reconnectMaxDelayMs: 1,
  connectTimeoutMs: 1_000,
  reconnectStableThresholdMs: 50,
  heartbeatTimeoutFactor: 0,
  tokenFetchTimeoutMs: 1_000,
  reconnectJitterRatio: 0,
  livenessStaleMs: 60_000,
  maxResponseBodyBytes: 10_485_760,
  maxConcurrentRequests: 100,
  drainTimeoutMs: 50,
  logLevel: "error",
  forwarding: [
    {
      target: "^https://internal[.]example(?:/.*)?$",
    },
  ],
};

const silentLogger = createLogger("error", {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

test("computeBackoffDelay is deterministic with no jitter and grows then saturates", () => {
  const initial = 1_000;
  const max = 30_000;

  expect(computeBackoffDelay(0, initial, max, 0)).toStrictEqual(0);
  expect(computeBackoffDelay(1, initial, max, 0)).toStrictEqual(1_000);
  expect(computeBackoffDelay(2, initial, max, 0)).toStrictEqual(2_000);
  expect(computeBackoffDelay(3, initial, max, 0)).toStrictEqual(4_000);
  // Saturates at max and never overflows for huge attempt counts.
  expect(computeBackoffDelay(100, initial, max, 0)).toStrictEqual(30_000);
  expect(Number.isFinite(computeBackoffDelay(1_000, initial, max, 0))).toBeTruthy();
});

test("computeBackoffDelay keeps jittered delays within [cap*(1-ratio), cap]", () => {
  const initial = 1_000;
  const max = 30_000;
  const ratio = 0.5;

  for (const rng of [() => 0, () => 0.5, () => 0.999]) {
    const value = computeBackoffDelay(3, initial, max, ratio, rng);
    const cap = 4_000;
    expect(value).toBeGreaterThanOrEqual(cap * (1 - ratio));
    expect(value).toBeLessThanOrEqual(cap);
  }

  // rng() === 0 yields the floor; full jitter ratio yields [0, cap].
  expect(computeBackoffDelay(1, initial, max, 1, () => 0)).toStrictEqual(0);
  expect(computeBackoffDelay(1, initial, max, 1, () => 1)).toStrictEqual(1_000);
});

test("runCloudWebSocketClient opens sockets, sends heartbeats, and closes on abort", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(baseConfig, createRuntime(), abortController.signal, status, silentLogger);

    await waitUntil(() => FakeWebSocket.instances[0]?.sent.length > 0);
    const socket = FakeWebSocket.instances[0];
    abortController.abort();
    await client;

    expect(socket.url).toStrictEqual("wss://cloud.example/ws");
    expect(socket.options?.headers?.Authorization).toStrictEqual("Bearer access-token");
    expect(socket.closed).toStrictEqual(true);
    expect(JSON.parse(socket.sent[0]).type).toStrictEqual("heartbeat");
  });
});

test("ReloadableWebSocketClient reconnects when YAML socket settings change", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    const abortController = new AbortController();
    const client = new ReloadableWebSocketClient(baseConfig, createRuntime(), status, silentLogger);
    const running = client.run(abortController.signal);

    await waitUntil(() => FakeWebSocket.instances.length === 1);
    client.replace({
      ...baseConfig,
      websocketUrl: "wss://cloud.example/reloaded",
      heartbeatIntervalMs: 5,
    });
    await waitUntil(() => FakeWebSocket.instances.length === 2);

    expect(FakeWebSocket.instances[0].closed).toStrictEqual(true);
    expect(FakeWebSocket.instances[1].url).toStrictEqual("wss://cloud.example/reloaded");

    client.replace({
      ...baseConfig,
      websocketUrl: "wss://cloud.example/reloaded",
      heartbeatIntervalMs: 5,
      forwarding: [
        {
          target: "^https://replacement[.]example(?:/.*)?$",
        },
      ],
    });
    await delayMs(10);
    expect(FakeWebSocket.instances.length).toStrictEqual(2);

    abortController.abort();
    await running;
  });
});

test("ReloadableWebSocketClient drains accepted requests before reconnecting", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    let release!: () => void;
    let started = false;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runtime = new ConnectorRuntime({
      protocolExecutor: {
        execute: async () => {
          started = true;
          await gate;
          return { statusCode: 204 };
        },
      },
      logger: silentLogger,
    });
    const abortController = new AbortController();
    const client = new ReloadableWebSocketClient(baseConfig, runtime, status, silentLogger);
    const running = client.run(abortController.signal);
    await waitUntil(() => FakeWebSocket.instances.length === 1);
    const socket = FakeWebSocket.instances[0];
    socket.receive(
      JSON.stringify({
        type: "request",
        requestId: "in-flight",
        request: { method: "GET", url: "https://internal.example/items" },
      }),
    );
    await waitUntil(() => started);

    client.replace({ ...baseConfig, websocketUrl: "wss://cloud.example/new" });
    await delayMs(10);
    expect(socket.closed).toStrictEqual(false);
    release();
    await waitUntil(() => FakeWebSocket.instances.length === 2);
    expect(socket.closed).toStrictEqual(true);
    expect(JSON.parse(socket.sent.at(-1)!).requestId).toStrictEqual("in-flight");

    abortController.abort();
    await running;
  });
});

test("runCloudWebSocketClient never rejects when authentication keeps failing", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      { ...baseConfig, cloudConnectorHost: "https://unavailable.example" },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => status.reconnectAttempt >= 2);
    abortController.abort();
    // Resolves (does not throw) => the supervision loop is uncrashable.
    await client;
    expect(FakeWebSocket.instances.length).toStrictEqual(0);
  });
});

test("runCloudWebSocketClient escalates backoff on a flapping peer (anti-flap)", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "openThenClose";
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      { ...baseConfig, reconnectStableThresholdMs: 10_000 },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    // Each instant open/close must increment the attempt counter rather than
    // resetting it to zero (which would cause a tight reconnect storm).
    await waitUntil(() => status.reconnectAttempt >= 3, 400);
    abortController.abort();
    await client;
    expect(status.reconnectAttempt).toBeGreaterThanOrEqual(3);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(3);
  });
});

test("runCloudWebSocketClient force-closes a half-open socket via the watchdog", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "openSilent";
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      {
        ...baseConfig,
        heartbeatIntervalMs: 5,
        heartbeatTimeoutFactor: 2,
      },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    // A silent (no inbound) socket is force-closed and reconnected.
    await waitUntil(() => FakeWebSocket.instances.length >= 2, 400);
    abortController.abort();
    await client;
    expect(FakeWebSocket.instances[0].closed).toStrictEqual(true);
  });
});

test("runCloudWebSocketClient force-settles when close never arrives", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "openSilentNoClose";
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      {
        ...baseConfig,
        heartbeatIntervalMs: 5,
        heartbeatTimeoutFactor: 2,
      },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => FakeWebSocket.instances[0]?.closed === true, 400);
    FakeWebSocket.behavior = "open";
    await waitUntil(() => FakeWebSocket.instances.length >= 2, 1_500);
    expect(status.connectionState).toStrictEqual("open");
    abortController.abort();
    await client;
  });
});

test("runCloudWebSocketClient keeps a socket with inbound traffic open", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "openWithInbound";
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      {
        ...baseConfig,
        heartbeatIntervalMs: 5,
        heartbeatTimeoutFactor: 2,
      },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => status.connectionState === "open");
    // Let several watchdog windows elapse while inbound frames keep arriving.
    await delayMs(60);
    expect(FakeWebSocket.instances.length).toStrictEqual(1);
    expect(FakeWebSocket.instances[0].closed).toStrictEqual(false);

    abortController.abort();
    await client;
  });
});

test("runCloudWebSocketClient retries when the socket never opens (connect timeout)", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "neverOpen";
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      { ...baseConfig, connectTimeoutMs: 10 },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => FakeWebSocket.instances.length >= 2, 400);
    abortController.abort();
    await client;
    expect(FakeWebSocket.instances[0].closed).toStrictEqual(true);
  });
});

test("runCloudWebSocketClient does not hang when aborted during the token fetch", async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const abortController = new AbortController();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://cloud.example/.well-known") {
        // Shutdown arrives while the token is still being fetched.
        abortController.abort();
        return Promise.resolve(
          Response.json({
            auth: { issuer: "https://cloud.example/realms/serviceware" },
          }),
        );
      }
      return Promise.resolve(Response.json({ access_token: "access-token" }));
    },
  });
  FakeWebSocket.instances = [];
  FakeWebSocket.behavior = "open";
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  try {
    // Must resolve promptly (not hang) and must not open a socket.
    await runCloudWebSocketClient(
      baseConfig,
      createRuntime(),
      abortController.signal,
      createRuntimeStatus(),
      silentLogger,
    );
    expect(FakeWebSocket.instances.length).toStrictEqual(0);
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  }
});

test("computeBackoffDelay clamps jitterRatio to [0, 1]", () => {
  expect(computeBackoffDelay(1, 1_000, 30_000, -5, () => 0)).toStrictEqual(1_000);
  expect(computeBackoffDelay(1, 1_000, 30_000, 5, () => 0)).toStrictEqual(0);
  expect(computeBackoffDelay(1, 1_000, 30_000, 5, () => 1)).toStrictEqual(1_000);
});

test("computeBackoffDelay returns zero for negative attempts and caps initial above max", () => {
  expect(computeBackoffDelay(-3, 1_000, 30_000, 0)).toStrictEqual(0);
  expect(computeBackoffDelay(1, 60_000, 30_000, 0)).toStrictEqual(30_000);
});

test("delay resolves after the timeout", async () => {
  vi.useFakeTimers();
  try {
    let resolved = false;
    const waiting = delay(1_000, new AbortController().signal).then(() => (resolved = true));

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toStrictEqual(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(resolved).toStrictEqual(true);
  } finally {
    vi.useRealTimers();
  }
});

test("delay resolves immediately when the signal is already aborted", async () => {
  vi.useFakeTimers();
  try {
    await delay(60_000, AbortSignal.abort());
    expect(vi.getTimerCount()).toStrictEqual(0);
  } finally {
    vi.useRealTimers();
  }
});

test("delay resolves on abort and leaves no timer behind", async () => {
  vi.useFakeTimers();
  try {
    const abortController = new AbortController();
    const waiting = delay(60_000, abortController.signal);

    expect(vi.getTimerCount()).toStrictEqual(1);
    abortController.abort();
    await waiting;
    expect(vi.getTimerCount()).toStrictEqual(0);
  } finally {
    vi.useRealTimers();
  }
});

test("runCloudWebSocketClient retries after a socket error before open and reports the failure", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "errorBeforeOpen";
    const errors: unknown[][] = [];
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(baseConfig, createRuntime(), abortController.signal, status, {
      ...silentLogger,
      error: (...data: unknown[]) => void errors.push(data),
    });

    await waitUntil(() => FakeWebSocket.instances.length >= 2, 400);
    abortController.abort();
    await client;

    expect(errors[0][0]).toStrictEqual("Cloud Connector WebSocket failed");
    expect(errors[0][1]).toEqual(expect.objectContaining({ message: "Unable to open Cloud Connector WebSocket" }));
    expect(status.reconnectAttempt).toBeGreaterThanOrEqual(1);
  });
});

test("runCloudWebSocketClient resets the attempt counter after a stable connection", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "openThenClose";
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      { ...baseConfig, reconnectStableThresholdMs: 0 },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => FakeWebSocket.instances.length >= 3, 400);
    abortController.abort();
    await client;

    expect(status.reconnectAttempt).toStrictEqual(0);
  });
});

test("runCloudWebSocketClient records connection state, connect time and inbound traffic in the status", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      { ...baseConfig, heartbeatIntervalMs: 60_000 },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => status.connectionState === "open");
    const connectedAt = status.lastConnectedAt!;
    expect(connectedAt).toBeGreaterThan(0);
    expect(status.lastInboundAt).toStrictEqual(connectedAt);

    await delayMs(5);
    FakeWebSocket.instances[0].receive('{"type":"heartbeat"}');
    expect(status.lastInboundAt!).toBeGreaterThan(connectedAt);
    expect(status.lastTickAt).toStrictEqual(status.lastInboundAt);

    abortController.abort();
    await client;
    expect(status.connectionState).toStrictEqual("disconnected");
  });
});

test("runCloudWebSocketClient answers inbound heartbeat frames over the socket", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      { ...baseConfig, heartbeatIntervalMs: 60_000 },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => FakeWebSocket.instances.length === 1 && status.connectionState === "open");
    FakeWebSocket.instances[0].receive('{"type":"heartbeat"}');
    await waitUntil(() => FakeWebSocket.instances[0].sent.length === 1);
    abortController.abort();
    await client;

    expect(JSON.parse(FakeWebSocket.instances[0].sent[0]).type).toStrictEqual("heartbeat");
  });
});

test("runCloudWebSocketClient does not run the watchdog when heartbeatTimeoutFactor is 0", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "openSilent";
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      { ...baseConfig, heartbeatIntervalMs: 2, heartbeatTimeoutFactor: 0 },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => status.connectionState === "open");
    await delayMs(40);
    expect(FakeWebSocket.instances.length).toStrictEqual(1);
    expect(FakeWebSocket.instances[0].closed).toStrictEqual(false);

    abortController.abort();
    await client;
  });
});

test("runCloudWebSocketClient logs the silent duration when the watchdog fires", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "openSilent";
    const warnings: string[] = [];
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      { ...baseConfig, heartbeatIntervalMs: 5, heartbeatTimeoutFactor: 2 },
      createRuntime(),
      abortController.signal,
      status,
      { ...silentLogger, warn: (...data: unknown[]) => void warnings.push(String(data[0])) },
    );

    await waitUntil(() => warnings.some((entry) => entry.includes("silent for")), 400);
    abortController.abort();
    await client;

    expect(warnings.find((entry) => entry.includes("silent for"))).toMatch(
      /^Cloud Connector WebSocket silent for \d+ms; reconnecting$/,
    );
  });
});

test("runCloudWebSocketClient does not send heartbeats while the socket is not OPEN", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "openNotReady";
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      { ...baseConfig, heartbeatIntervalMs: 2 },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => status.connectionState === "open");
    await delayMs(20);
    abortController.abort();
    await client;

    expect(FakeWebSocket.instances[0].sent).toStrictEqual([]);
  });
});

test("runCloudWebSocketClient reconnects when sending a heartbeat throws", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "sendThrows";
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      { ...baseConfig, heartbeatIntervalMs: 2 },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => FakeWebSocket.instances.length >= 2, 400);
    abortController.abort();
    await client;

    expect(FakeWebSocket.instances[0].closed).toStrictEqual(true);
  });
});

test("runCloudWebSocketClient warns and closes when the drain times out on shutdown", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (...data: unknown[]) => void warnings.push(String(data[0])) };
    let started = false;
    const runtime = new ConnectorRuntime({
      protocolExecutor: {
        execute: () => {
          started = true;
          return new Promise(() => undefined);
        },
      },
      logger: silentLogger,
    });
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      { ...baseConfig, heartbeatIntervalMs: 60_000, drainTimeoutMs: 10 },
      runtime,
      abortController.signal,
      status,
      logger,
    );
    await waitUntil(() => FakeWebSocket.instances.length === 1);
    FakeWebSocket.instances[0].receive(
      JSON.stringify({
        type: "request",
        requestId: "stuck",
        request: { method: "GET", url: "https://internal.example/items" },
      }),
    );
    await waitUntil(() => started);

    abortController.abort();
    await client;

    expect(warnings).toContain("Cloud Connector drain timed out after 10ms");
    expect(FakeWebSocket.instances[0].closed).toStrictEqual(true);
  });
});

test("runCloudWebSocketClient waits for in-flight requests before closing on shutdown", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    let release!: () => void;
    let started = false;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runtime = new ConnectorRuntime({
      protocolExecutor: {
        execute: async () => {
          started = true;
          await gate;
          return { statusCode: 204 };
        },
      },
      logger: silentLogger,
    });
    const abortController = new AbortController();
    const client = runCloudWebSocketClient(
      { ...baseConfig, heartbeatIntervalMs: 60_000, drainTimeoutMs: 5_000 },
      runtime,
      abortController.signal,
      status,
      silentLogger,
    );
    await waitUntil(() => FakeWebSocket.instances.length === 1);
    const socket = FakeWebSocket.instances[0];
    socket.receive(
      JSON.stringify({
        type: "request",
        requestId: "in-flight",
        request: { method: "GET", url: "https://internal.example/items" },
      }),
    );
    await waitUntil(() => started);

    abortController.abort();
    await delayMs(10);
    expect(socket.closed).toStrictEqual(false);
    release();
    await client;

    expect(socket.closed).toStrictEqual(true);
    expect(JSON.parse(socket.sent.at(-1)!).requestId).toStrictEqual("in-flight");
  });
});

test("ReloadableWebSocketClient reconnects when only the heartbeat interval changes", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    const abortController = new AbortController();
    const client = new ReloadableWebSocketClient(baseConfig, createRuntime(), status, silentLogger);
    const running = client.run(abortController.signal);
    await waitUntil(() => FakeWebSocket.instances.length === 1);

    client.replace({ ...baseConfig, heartbeatIntervalMs: 7 });
    await waitUntil(() => FakeWebSocket.instances.length === 2);

    expect(FakeWebSocket.instances[0].closed).toStrictEqual(true);
    abortController.abort();
    await running;
  });
});

test("ReloadableWebSocketClient does not reconnect for reconnect-timing-only changes", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    const abortController = new AbortController();
    const client = new ReloadableWebSocketClient(baseConfig, createRuntime(), status, silentLogger);
    const running = client.run(abortController.signal);
    await waitUntil(() => FakeWebSocket.instances.length === 1);

    client.replace({ ...baseConfig, reconnectInitialDelayMs: 500, drainTimeoutMs: 500 });
    await delayMs(20);

    expect(FakeWebSocket.instances.length).toStrictEqual(1);
    expect(FakeWebSocket.instances[0].closed).toStrictEqual(false);
    abortController.abort();
    await running;
  });
});

test("ReloadableWebSocketClient applies the replaced config to the next connection after a drop", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    const abortController = new AbortController();
    const client = new ReloadableWebSocketClient(baseConfig, createRuntime(), status, silentLogger);
    const running = client.run(abortController.signal);
    await waitUntil(() => FakeWebSocket.instances.length === 1);

    client.replace({ ...baseConfig, websocketUrl: "wss://cloud.example/second" });
    await waitUntil(() => FakeWebSocket.instances.length === 2);
    client.replace({ ...baseConfig, websocketUrl: "wss://cloud.example/third" });
    await waitUntil(() => FakeWebSocket.instances.length === 3);

    expect(FakeWebSocket.instances.map((socket) => socket.url)).toStrictEqual([
      "wss://cloud.example/ws",
      "wss://cloud.example/second",
      "wss://cloud.example/third",
    ]);
    abortController.abort();
    await running;
  });
});

test("ReloadableWebSocketClient replace before run does not throw and run honors an already aborted signal", async () => {
  await withFakeCloud(async ({ status }) => {
    const client = new ReloadableWebSocketClient(baseConfig, createRuntime(), status, silentLogger);

    expect(() => client.replace({ ...baseConfig, websocketUrl: "wss://cloud.example/other" })).not.toThrow();
    await client.run(AbortSignal.abort());

    expect(FakeWebSocket.instances.length).toStrictEqual(0);
  });
});

test("ReloadableWebSocketClient resolves when aborted while connected", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    const abortController = new AbortController();
    const client = new ReloadableWebSocketClient(baseConfig, createRuntime(), status, silentLogger);
    const running = client.run(abortController.signal);
    await waitUntil(() => status.connectionState === "open");

    abortController.abort();
    await running;

    expect(FakeWebSocket.instances.length).toStrictEqual(1);
    expect(FakeWebSocket.instances[0].closed).toStrictEqual(true);
  });
});

function createRuntime(): ConnectorRuntime {
  return new ConnectorRuntime({
    protocolExecutor: {
      execute: () => Promise.resolve({ statusCode: 204 }),
    } as unknown as ProtocolExecutor,
    logger: silentLogger,
  });
}

/** Stubs fetch (token endpoint) and WebSocket, restoring them afterwards. */
async function withFakeCloud(
  run: (ctx: { status: ReturnType<typeof createRuntimeStatus> }) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://cloud.example/.well-known") {
        return Promise.resolve(
          Response.json({
            auth: { issuer: "https://cloud.example/realms/serviceware" },
          }),
        );
      }
      if (url === "https://cloud.example/realms/serviceware/protocol/openid-connect/token") {
        return Promise.resolve(Response.json({ access_token: "access-token" }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  });
  FakeWebSocket.instances = [];
  FakeWebSocket.behavior = "open";
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  try {
    await run({ status: createRuntimeStatus() });
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  }
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean, maxAttempts = 100): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (condition()) {
      return;
    }
    await delayMs(1);
  }

  throw new Error("Condition was not met in time");
}

type FakeBehavior =
  | "open"
  | "errorBeforeOpen"
  | "sendThrows"
  | "openNotReady"
  | "openThenClose"
  | "openSilent"
  | "openSilentNoClose"
  | "openWithInbound"
  | "neverOpen";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static behavior: FakeBehavior = "open";
  readonly sent: string[] = [];
  readonly url: string;
  readonly options?: { headers?: Record<string, string> };
  readyState = FakeWebSocket.OPEN;
  closed = false;
  #inboundTimer: ReturnType<typeof setInterval> | undefined;

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    super();
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
    const behavior = FakeWebSocket.behavior;
    if (behavior === "errorBeforeOpen") {
      this.readyState = FakeWebSocket.CONNECTING;
      queueMicrotask(() => this.dispatchEvent(new Event("error")));
      return;
    }
    if (behavior === "neverOpen") {
      this.readyState = FakeWebSocket.CONNECTING;
      return;
    }

    if (behavior === "openNotReady") this.readyState = FakeWebSocket.CLOSING;
    queueMicrotask(() => {
      this.dispatchEvent(new Event("open"));
      if (behavior === "openThenClose") {
        this.close();
      } else if (behavior === "openWithInbound") {
        this.#inboundTimer = setInterval(() => this.receive('{"type":"heartbeat"}'), 1);
      }
    });
  }

  send(data: string): void {
    if (FakeWebSocket.behavior === "sendThrows") throw new Error("send failed");
    this.sent.push(data);
  }

  receive(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    if (this.#inboundTimer !== undefined) {
      clearInterval(this.#inboundTimer);
      this.#inboundTimer = undefined;
    }
    if (FakeWebSocket.behavior === "openSilentNoClose") return;
    this.dispatchEvent(new Event("close"));
  }
}
