import { expect, test } from "vitest";
import type { CloudConnectorMessageFrame } from "./generated/models.ts";
import {
  createErrorFrame,
  createHeartbeatFrame,
  createResponseFrame,
  isHeartbeatFrame,
  isRequestFrame,
  parseMessageFrame,
  serializeFrame,
} from "./protocol.ts";

test("parseMessageFrame parses request and heartbeat frames", () => {
  const requestFrame: CloudConnectorMessageFrame = {
    type: "request",
    requestId: "request-1",
    request: { method: "GET", url: "/users" },
  };
  const heartbeatFrame: CloudConnectorMessageFrame = {
    type: "heartbeat",
    sentAt: "2024-01-01T00:00:00.000Z",
  };

  const parsedRequest = parseMessageFrame(JSON.stringify(requestFrame));
  const parsedHeartbeat = parseMessageFrame(JSON.stringify(heartbeatFrame));

  expect(isRequestFrame(parsedRequest)).toStrictEqual(true);
  expect(isHeartbeatFrame(parsedHeartbeat)).toStrictEqual(true);
  expect(parsedRequest).toStrictEqual(requestFrame);
  expect(parsedHeartbeat).toStrictEqual(heartbeatFrame);
});

test("parseMessageFrame rejects malformed frames", () => {
  expect(() => parseMessageFrame(new Uint8Array())).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("WebSocket frames must be JSON strings"),
    }),
  );
  expect(() => parseMessageFrame("{")).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("WebSocket frame is not valid JSON"),
    }),
  );
  expect(() => parseMessageFrame("{}")).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("WebSocket frame must contain a string type"),
    }),
  );
  expect(() => parseMessageFrame('{"type":"unknown"}')).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("Unsupported frame type: unknown"),
    }),
  );
  expect(() => parseMessageFrame('{"type":"request"}')).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("requestId"),
    }),
  );
  expect(() => parseMessageFrame('{"type":"request","requestId":"request-1","request":{}}')).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("request.method"),
    }),
  );
});

test("frame factories create serializable outbound frames", () => {
  const heartbeat = createHeartbeatFrame();
  const response = createResponseFrame("request-1", {
    statusCode: 204,
    headers: { "x-test": ["ok"] },
  });
  const error = createErrorFrame("request-2", {
    code: "FAILED",
    message: "Request failed",
  });

  expect(heartbeat.type).toStrictEqual("heartbeat");
  expect(response).toStrictEqual({
    type: "response",
    requestId: "request-1",
    response: { statusCode: 204, headers: { "x-test": ["ok"] } },
  });
  expect(error).toStrictEqual({
    type: "response",
    requestId: "request-2",
    error: { code: "FAILED", message: "Request failed" },
  });
  expect(serializeFrame(error)).toStrictEqual(JSON.stringify(error));
});
