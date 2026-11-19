import { expect, test } from "vitest";
import { ConnectorRuntime, type ProtocolExecutor, ReloadableProtocolExecutor } from "./connector.ts";
import type { CloudConnectorMessageFrame, CloudConnectorRequestFrame } from "./generated/models.ts";
import { createLogger } from "./logger.ts";
import type { WritableFrame } from "./protocol.ts";
import { RuntimeError } from "./runtime-error.ts";

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

  await runtime.handleFrame({ type: "response", requestId: "request-1" } as CloudConnectorMessageFrame, (frame) => {
    sentFrames.push(frame);
  });

  expect(sentFrames).toStrictEqual([]);
  expect(warnings).toStrictEqual(["Ignoring unsupported inbound frame type: response"]);
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

  const errors = socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.error);
  expect(errors.map((frame) => frame.error.code)).toStrictEqual(["TOO_MANY_REQUESTS", "CONNECTOR_DRAINING"]);
  release();
  expect(await draining).toStrictEqual(true);
});

test("ConnectorRuntime answers a heartbeat frame with a heartbeat frame", async () => {
  const sentFrames: WritableFrame[] = [];

  await createRuntime().handleFrame({ type: "heartbeat" }, (frame) => {
    sentFrames.push(frame);
  });

  expect(sentFrames).toHaveLength(1);
  expect(sentFrames[0].type).toStrictEqual("heartbeat");
  expect((sentFrames[0] as { sentAt?: string }).sentAt).toEqual(expect.any(String));
});

test("ConnectorRuntime answers executor failures with an error frame carrying the error code", async () => {
  const warnings: string[] = [];
  const runtime = new ConnectorRuntime({
    protocolExecutor: {
      execute: () => Promise.reject(new RuntimeError("TARGET_DENIED", "Target is not allowed")),
    },
    logger: { ...silentLogger, warn: (...data: unknown[]) => void warnings.push(String(data[0])) },
  });
  const sentFrames: WritableFrame[] = [];

  await runtime.handleFrame(requestFrame("request-1"), (frame) => {
    sentFrames.push(frame);
  });

  expect(sentFrames).toStrictEqual([
    {
      type: "response",
      requestId: "request-1",
      error: { code: "TARGET_DENIED", message: "Target is not allowed" },
    },
  ]);
  expect(warnings).toStrictEqual(["Forwarding request request-1 failed: TARGET_DENIED"]);
});

test("ConnectorRuntime maps unexpected executor errors to UNEXPECTED_ERROR frames", async () => {
  const runtime = new ConnectorRuntime({
    protocolExecutor: {
      execute: () => Promise.reject(new Error("socket hang up")),
    },
    logger: silentLogger,
  });
  const sentFrames: WritableFrame[] = [];

  await runtime.handleFrame(requestFrame("request-1"), (frame) => {
    sentFrames.push(frame);
  });

  expect(sentFrames).toStrictEqual([
    {
      type: "response",
      requestId: "request-1",
      error: { code: "UNEXPECTED_ERROR", message: "socket hang up" },
    },
  ]);
});

test("ConnectorRuntime propagates a failing sender from handleFrame", async () => {
  await expect(
    createRuntime().handleFrame({ type: "heartbeat" }, () => {
      throw new Error("send failed");
    }),
  ).rejects.toThrow("send failed");
});

test("ConnectorRuntime drops unparseable WebSocket messages with a warning and keeps serving", async () => {
  const warnings: string[] = [];
  const socket = new FakeSocket();
  createRuntime({ warn: (...data: unknown[]) => void warnings.push(String(data[0])) }).attachWebSocket(
    socket as unknown as WebSocket,
  );

  for (const data of ["{", '{"type":"nope"}', '{"type":"request","requestId":"r"}', new ArrayBuffer(1)]) {
    socket.dispatchEvent(new MessageEvent("message", { data }));
  }
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(requestFrame("request-1")) }));
  await nextTick();

  expect(warnings).toStrictEqual([
    "WebSocket frame is not valid JSON",
    "Unsupported frame type: nope",
    "Request frame must contain a request object",
    "WebSocket frames must be JSON strings",
  ]);
  expect(socket.sent.map((frame) => JSON.parse(frame).requestId)).toStrictEqual(["request-1"]);
});

test("ConnectorRuntime answers WebSocket heartbeat frames and ignores response frames", async () => {
  const warnings: string[] = [];
  const socket = new FakeSocket();
  createRuntime({ warn: (...data: unknown[]) => void warnings.push(String(data[0])) }).attachWebSocket(
    socket as unknown as WebSocket,
  );

  socket.dispatchEvent(new MessageEvent("message", { data: '{"type":"heartbeat"}' }));
  socket.dispatchEvent(
    new MessageEvent("message", { data: '{"type":"response","requestId":"r","response":{"statusCode":200}}' }),
  );
  await nextTick();

  expect(socket.sent.map((frame) => JSON.parse(frame).type)).toStrictEqual(["heartbeat"]);
  expect(warnings).toStrictEqual(["Ignoring unsupported inbound frame type: response"]);
});

test("ConnectorRuntime logs when a request handler fails to send its response", async () => {
  const errors: unknown[][] = [];
  const socket = new FakeSocket();
  socket.send = () => {
    throw new Error("socket closed");
  };
  createRuntime({ error: (...data: unknown[]) => void errors.push(data) }).attachWebSocket(
    socket as unknown as WebSocket,
  );

  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(requestFrame("request-1")) }));
  await nextTick();

  expect(errors).toHaveLength(1);
  expect(errors[0][0]).toStrictEqual("Failed to process WebSocket message for request request-1");
  expect(errors[0][1]).toEqual(expect.objectContaining({ message: "socket closed" }));
});

test("ConnectorRuntime logs when a heartbeat response fails to send without naming a request", async () => {
  const errors: unknown[][] = [];
  const socket = new FakeSocket();
  socket.send = () => {
    throw new Error("socket closed");
  };
  createRuntime({ error: (...data: unknown[]) => void errors.push(data) }).attachWebSocket(
    socket as unknown as WebSocket,
  );

  socket.dispatchEvent(new MessageEvent("message", { data: '{"type":"heartbeat"}' }));
  await nextTick();

  expect(errors.map((entry) => entry[0])).toStrictEqual(["Failed to process WebSocket message"]);
});

test("ConnectorRuntime frees a concurrency slot once a request completes", async () => {
  let release!: () => void;
  let calls = 0;
  const runtime = new ConnectorRuntime({
    protocolExecutor: {
      execute: async () => {
        calls += 1;
        if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
        return { statusCode: 204 };
      },
    },
    logger: silentLogger,
    maximumConcurrentRequests: 1,
  });
  const socket = new FakeSocket();
  runtime.attachWebSocket(socket as unknown as WebSocket);
  const dispatch = (requestId: string) =>
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(requestFrame(requestId)) }));

  dispatch("first");
  await waitUntil(() => calls === 1);
  release();
  await nextTick();
  dispatch("second");
  await nextTick();

  expect(socket.sent.map((frame) => JSON.parse(frame))).toStrictEqual([
    { type: "response", requestId: "first", response: { statusCode: 204 } },
    { type: "response", requestId: "second", response: { statusCode: 204 } },
  ]);
});

test("ConnectorRuntime does not count heartbeat frames against the concurrency limit", async () => {
  const socket = new FakeSocket();
  const runtime = new ConnectorRuntime({
    protocolExecutor: { execute: () => Promise.resolve({ statusCode: 204 }) },
    logger: silentLogger,
    maximumConcurrentRequests: 1,
  });
  const attachment = runtime.attachWebSocket(socket as unknown as WebSocket);

  for (let index = 0; index < 3; index += 1) {
    socket.dispatchEvent(new MessageEvent("message", { data: '{"type":"heartbeat"}' }));
  }
  await nextTick();
  await attachment.drain(10);
  socket.dispatchEvent(new MessageEvent("message", { data: '{"type":"heartbeat"}' }));
  await nextTick();

  expect(socket.sent.map((frame) => JSON.parse(frame).type)).toStrictEqual([
    "heartbeat",
    "heartbeat",
    "heartbeat",
    "heartbeat",
  ]);
});

test("ConnectorRuntime drain resolves true at once with nothing in flight and rejects later requests", async () => {
  const socket = new FakeSocket();
  const attachment = createRuntime().attachWebSocket(socket as unknown as WebSocket);

  expect(await attachment.drain(10_000)).toStrictEqual(true);
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(requestFrame("late")) }));
  await nextTick();

  expect(socket.sent.map((frame) => JSON.parse(frame))).toStrictEqual([
    {
      type: "response",
      requestId: "late",
      error: {
        code: "CONNECTOR_DRAINING",
        message: "Cloud Connector is draining before reconnect or shutdown",
      },
    },
  ]);
});

test("ConnectorRuntime drain resolves false when in-flight requests outlast the timeout", async () => {
  const runtime = new ConnectorRuntime({
    protocolExecutor: { execute: () => new Promise(() => undefined) },
    logger: silentLogger,
  });
  const socket = new FakeSocket();
  const attachment = runtime.attachWebSocket(socket as unknown as WebSocket);
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(requestFrame("stuck")) }));
  await nextTick();

  expect(await attachment.drain(5)).toStrictEqual(false);
});

test("ConnectorRuntime drain counts requests that fail as finished", async () => {
  const runtime = new ConnectorRuntime({
    protocolExecutor: { execute: () => Promise.reject(new Error("boom")) },
    logger: silentLogger,
  });
  const socket = new FakeSocket();
  socket.send = () => {
    throw new Error("socket closed");
  };
  const attachment = runtime.attachWebSocket(socket as unknown as WebSocket);
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(requestFrame("failing")) }));

  expect(await attachment.drain(1_000)).toStrictEqual(true);
});

test("ConnectorRuntime logs when a draining rejection cannot be sent", async () => {
  const errors: unknown[][] = [];
  const socket = new FakeSocket();
  socket.send = () => {
    throw new Error("socket closed");
  };
  const attachment = createRuntime({ error: (...data: unknown[]) => void errors.push(data) }).attachWebSocket(
    socket as unknown as WebSocket,
  );
  await attachment.drain(10);

  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(requestFrame("late")) }));
  await nextTick();

  expect(errors).toHaveLength(1);
  expect(errors[0][0]).toStrictEqual("Failed to reject draining request late");
  expect(errors[0][1]).toEqual(expect.objectContaining({ message: "socket closed" }));
});

test("ConnectorRuntime logs when a concurrency rejection cannot be sent", async () => {
  const errors: unknown[][] = [];
  const socket = new FakeSocket();
  socket.send = () => {
    throw new Error("socket closed");
  };
  const runtime = new ConnectorRuntime({
    protocolExecutor: { execute: () => new Promise(() => undefined) },
    logger: { ...silentLogger, error: (...data: unknown[]) => void errors.push(data) },
    maximumConcurrentRequests: 1,
  });
  runtime.attachWebSocket(socket as unknown as WebSocket);

  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(requestFrame("stuck")) }));
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(requestFrame("excess")) }));
  await nextTick();

  expect(errors).toHaveLength(1);
  expect(errors[0][0]).toStrictEqual("Failed to reject excess request excess");
  expect(errors[0][1]).toEqual(expect.objectContaining({ message: "socket closed" }));
});

test("ConnectorRuntime logs WebSocket open and close events", () => {
  const infos: string[] = [];
  const warnings: unknown[][] = [];
  const socket = new FakeSocket();
  createRuntime({
    info: (...data: unknown[]) => void infos.push(String(data[0])),
    warn: (...data: unknown[]) => void warnings.push(data),
  }).attachWebSocket(socket as unknown as WebSocket);

  socket.dispatchEvent(new Event("open"));
  socket.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "gone" }));

  expect(infos).toStrictEqual(["Cloud Connector WebSocket opened"]);
  expect(warnings).toStrictEqual([["Cloud Connector WebSocket closed", { code: 1006, reason: "gone" }]]);
});

test("ConnectorRuntime defaults to a concurrency limit of 100", async () => {
  const runtime = new ConnectorRuntime({
    protocolExecutor: { execute: () => new Promise(() => undefined) },
    logger: silentLogger,
  });
  const socket = new FakeSocket();
  runtime.attachWebSocket(socket as unknown as WebSocket);

  for (let index = 0; index < 101; index += 1) {
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(requestFrame(`request-${index}`)) }));
  }
  await nextTick();

  expect(socket.sent.map((frame) => JSON.parse(frame))).toStrictEqual([
    {
      type: "response",
      requestId: "request-100",
      error: { code: "TOO_MANY_REQUESTS", message: "Cloud Connector request concurrency limit reached" },
    },
  ]);
});

test("ReloadableProtocolExecutor keeps in-flight requests on the executor they started with", async () => {
  let release!: () => void;
  const executor = new ReloadableProtocolExecutor({
    execute: async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { statusCode: 200, body: "first" };
    },
  });
  const frame = requestFrame("request-1");

  const inFlight = executor.execute(frame);
  executor.replace({ execute: () => Promise.resolve({ statusCode: 200, body: "second" }) });
  release();

  expect((await inFlight).body).toStrictEqual("first");
  expect((await executor.execute(frame)).body).toStrictEqual("second");
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

function requestFrame(requestId: string): CloudConnectorRequestFrame {
  return { type: "request", requestId, request: { method: "GET", url: "/users" } };
}

function createRuntime(logger?: Partial<typeof silentLogger>): ConnectorRuntime {
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
