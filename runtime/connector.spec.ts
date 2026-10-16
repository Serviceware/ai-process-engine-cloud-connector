import { expect, test } from "vitest";
import {
  ConnectorRuntime,
  type ProtocolExecutor,
  ReloadableProtocolExecutor,
} from "./connector.ts";
import type { CloudConnectorMessageFrame } from "./generated/models.ts";
import { createLogger } from "./logger.ts";
import type { WritableFrame } from "./protocol.ts";

const silentLogger = createLogger("error", {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

test("ConnectorRuntime ignores unsupported inbound response frames", async () => {
  const warnings: string[] = [];
  const runtime = createRuntime({
    warn: (...data: unknown[]) => {
      warnings.push(String(data[0]));
    },
  });
  const sentFrames: WritableFrame[] = [];

  await runtime.handleFrame(
    { type: "response", requestId: "request-1" } as CloudConnectorMessageFrame,
    (frame) => {
      sentFrames.push(frame);
    },
  );

  expect(sentFrames).toStrictEqual([]);
  expect(warnings).toStrictEqual([
    "Ignoring unsupported inbound frame type: response",
  ]);
});

test("ConnectorRuntime executes protocol executor for request frames", async () => {
  const sentFrames: WritableFrame[] = [];
  const protocolExecutor = {
    execute: () =>
      Promise.resolve({
        statusCode: 207,
        headers: { "x-mode": ["forwarding"] },
        body: "forwarding-response",
      }),
  } as unknown as ProtocolExecutor;
  const runtime = new ConnectorRuntime({
    protocolExecutor,
    logger: silentLogger,
  });

  await runtime.handleFrame(
    {
      type: "request",
      requestId: "request-1",
      request: { method: "GET", url: "/users" },
    },
    (frame) => {
      sentFrames.push(frame);
    },
  );

  expect(sentFrames).toStrictEqual([
    {
      type: "response",
      requestId: "request-1",
      response: {
        statusCode: 207,
        headers: { "x-mode": ["forwarding"] },
        body: "forwarding-response",
      },
    },
  ]);
});

test("ConnectorRuntime attaches to WebSocket messages and serializes responses", async () => {
  const socket = new FakeSocket();
  const runtime = createRuntime();

  runtime.attachWebSocket(socket as unknown as WebSocket);
  socket.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "request",
        requestId: "request-1",
        request: { method: "GET", url: "/users" },
      }),
    }),
  );
  await nextTick();

  expect(socket.sent.map((frame) => JSON.parse(frame))).toStrictEqual([
    {
      type: "response",
      requestId: "request-1",
      response: { statusCode: 204 },
    },
  ]);
});

test("ConnectorRuntime bounds concurrency and drains accepted requests", async () => {
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
    maximumConcurrentRequests: 1,
  });
  const socket = new FakeSocket();
  const attachment = runtime.attachWebSocket(socket as unknown as WebSocket);
  const request = (requestId: string) =>
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "request",
        requestId,
        request: { method: "GET", url: "/users" },
      }),
    });

  socket.dispatchEvent(request("first"));
  await waitUntil(() => started);
  socket.dispatchEvent(request("excess"));
  await nextTick();
  const draining = attachment.drain(100);
  socket.dispatchEvent(request("draining"));
  await nextTick();

  const errors = socket.sent
    .map((frame) => JSON.parse(frame))
    .filter((frame) => frame.error);
  expect(errors.map((frame) => frame.error.code)).toStrictEqual([
    "TOO_MANY_REQUESTS",
    "CONNECTOR_DRAINING",
  ]);
  release();
  expect(await draining).toStrictEqual(true);
});

test("ReloadableProtocolExecutor switches subsequent requests atomically", async () => {
  const executor = new ReloadableProtocolExecutor({
    execute: () => Promise.resolve({ statusCode: 200, body: "first" }),
  });
  const frame = {
    type: "request",
    requestId: "request-1",
    request: { method: "GET", url: "/users" },
  } as const;

  expect((await executor.execute(frame)).body).toStrictEqual("first");
  executor.replace({
    execute: () => Promise.resolve({ statusCode: 200, body: "second" }),
  });
  expect((await executor.execute(frame)).body).toStrictEqual("second");
});

function createRuntime(
  logger?: Partial<typeof silentLogger>,
): ConnectorRuntime {
  return new ConnectorRuntime({
    protocolExecutor: {
      execute: () => Promise.resolve({ statusCode: 204 }),
    } as unknown as ProtocolExecutor,
    logger: { ...silentLogger, ...logger },
  });
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await nextTick();
  }
  throw new Error("Condition was not met in time");
}

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }
}
