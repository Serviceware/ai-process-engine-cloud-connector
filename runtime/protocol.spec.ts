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

const validRequest = { method: "GET", url: "/users" };

function requestFrameWith(request: Record<string, unknown>): string {
  return JSON.stringify({ type: "request", requestId: "request-1", request });
}

function invalidFrame(messagePart: string) {
  return expect.objectContaining({
    name: "RuntimeError",
    code: expect.stringMatching(/^(INVALID_FRAME|UNSUPPORTED_FRAME)$/),
    message: expect.stringContaining(messagePart),
  });
}

test("parseMessageFrame classifies rejections with INVALID_FRAME or UNSUPPORTED_FRAME", () => {
  expect(() => parseMessageFrame("{")).toThrow(expect.objectContaining({ code: "INVALID_FRAME" }));
  expect(() => parseMessageFrame('{"type":"other"}')).toThrow(expect.objectContaining({ code: "UNSUPPORTED_FRAME" }));
});

test("parseMessageFrame keeps the JSON syntax error as cause", () => {
  expect(() => parseMessageFrame("{")).toThrow(expect.objectContaining({ cause: expect.any(SyntaxError) }));
});

test("parseMessageFrame rejects JSON values that are not objects with a string type", () => {
  for (const data of ["null", "[]", '["request"]', '"request"', "42", "true", '{"type":1}', '{"type":null}']) {
    expect(() => parseMessageFrame(data)).toThrow(invalidFrame("must contain a string type"));
  }
});

test("parseMessageFrame rejects request frames without a usable requestId", () => {
  for (const requestId of ["", 1, null, {}]) {
    expect(() => parseMessageFrame(JSON.stringify({ type: "request", requestId, request: validRequest }))).toThrow(
      invalidFrame("non-empty requestId"),
    );
  }
});

test("parseMessageFrame rejects request frames without a request object", () => {
  for (const request of [undefined, null, [], "GET /users", 1]) {
    expect(() => parseMessageFrame(JSON.stringify({ type: "request", requestId: "request-1", request }))).toThrow(
      invalidFrame("request object"),
    );
  }
});

test("parseMessageFrame accepts every documented HTTP method and rejects others", () => {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    expect(parseMessageFrame(requestFrameWith({ method, url: "/users" }))).toMatchObject({
      request: { method },
    });
  }
  for (const method of ["get", "TRACE", "CONNECT", "", 1, null]) {
    expect(() => parseMessageFrame(requestFrameWith({ method, url: "/users" }))).toThrow(
      invalidFrame("request.method"),
    );
  }
});

test("parseMessageFrame rejects empty or non-string request.url", () => {
  for (const url of [undefined, "", 1, null, ["/users"]]) {
    expect(() => parseMessageFrame(requestFrameWith({ method: "GET", url }))).toThrow(
      invalidFrame("non-empty request.url"),
    );
  }
});

test("parseMessageFrame validates request.headers shape", () => {
  expect(
    parseMessageFrame(requestFrameWith({ ...validRequest, headers: { accept: ["a", "b"], empty: [] } })),
  ).toMatchObject({ request: { headers: { accept: ["a", "b"], empty: [] } } });

  for (const headers of [null, [], "accept", 1]) {
    expect(() => parseMessageFrame(requestFrameWith({ ...validRequest, headers }))).toThrow(
      invalidFrame("request.headers must be an object"),
    );
  }
  for (const headers of [{ accept: "text/plain" }, { accept: [1] }, { accept: ["ok", null] }, { accept: null }]) {
    expect(() => parseMessageFrame(requestFrameWith({ ...validRequest, headers }))).toThrow(
      invalidFrame("header values must be arrays of strings"),
    );
  }
});

test("parseMessageFrame accepts string, null or absent request.body and rejects other types", () => {
  for (const body of ["payload", "", null]) {
    expect(parseMessageFrame(requestFrameWith({ ...validRequest, body }))).toMatchObject({ request: { body } });
  }
  expect(parseMessageFrame(requestFrameWith(validRequest))).toMatchObject({ request: validRequest });
  for (const body of [1, true, {}, ["x"]]) {
    expect(() => parseMessageFrame(requestFrameWith({ ...validRequest, body }))).toThrow(
      invalidFrame("request.body must be a string or null"),
    );
  }
});

test("parseMessageFrame enforces request.timeoutSeconds as integer from 1 to 90", () => {
  for (const timeoutSeconds of [1, 10, 90]) {
    expect(parseMessageFrame(requestFrameWith({ ...validRequest, timeoutSeconds }))).toMatchObject({
      request: { timeoutSeconds },
    });
  }
  for (const timeoutSeconds of [0, -1, 91, 1.5, "10", null, Number.NaN]) {
    expect(() => parseMessageFrame(requestFrameWith({ ...validRequest, timeoutSeconds }))).toThrow(
      invalidFrame("request.timeoutSeconds must be an integer from 1 to 90"),
    );
  }
});

test("parseMessageFrame parses response frames with a response or an error", () => {
  const withResponse = { type: "response", requestId: "request-1", response: { statusCode: 200 } };
  const withError = { type: "response", requestId: "request-1", error: { code: "FAILED", message: "boom" } };
  const bare = { type: "response", requestId: "request-1" };

  expect(parseMessageFrame(JSON.stringify(withResponse))).toStrictEqual(withResponse);
  expect(parseMessageFrame(JSON.stringify(withError))).toStrictEqual(withError);
  expect(parseMessageFrame(JSON.stringify(bare))).toStrictEqual(bare);
});

test("parseMessageFrame rejects response frames without a usable requestId", () => {
  for (const requestId of [undefined, "", 1]) {
    expect(() =>
      parseMessageFrame(JSON.stringify({ type: "response", requestId, response: { statusCode: 200 } })),
    ).toThrow(invalidFrame("non-empty requestId"));
  }
});

test("parseMessageFrame validates response.statusCode as integer HTTP status", () => {
  for (const statusCode of [100, 200, 599]) {
    expect(
      parseMessageFrame(JSON.stringify({ type: "response", requestId: "request-1", response: { statusCode } })),
    ).toMatchObject({ response: { statusCode } });
  }
  for (const statusCode of [99, 600, 200.5, "200", null, undefined]) {
    expect(() =>
      parseMessageFrame(JSON.stringify({ type: "response", requestId: "request-1", response: { statusCode } })),
    ).toThrow(invalidFrame("response.statusCode must be an HTTP status code"));
  }
  for (const response of [null, [], "ok", 200]) {
    expect(() => parseMessageFrame(JSON.stringify({ type: "response", requestId: "request-1", response }))).toThrow(
      invalidFrame("response must be an object"),
    );
  }
});

test("parseMessageFrame validates response error shape", () => {
  for (const error of [null, [], "boom", 1]) {
    expect(() => parseMessageFrame(JSON.stringify({ type: "response", requestId: "request-1", error }))).toThrow(
      invalidFrame("error must be an object"),
    );
  }
  for (const error of [{}, { code: "X" }, { message: "m" }, { code: 1, message: "m" }, { code: "X", message: null }]) {
    expect(() => parseMessageFrame(JSON.stringify({ type: "response", requestId: "request-1", error }))).toThrow(
      invalidFrame("string code and message fields"),
    );
  }
});

test("parseMessageFrame accepts heartbeat frames with or without sentAt and rejects non-string sentAt", () => {
  expect(parseMessageFrame('{"type":"heartbeat"}')).toStrictEqual({ type: "heartbeat" });
  for (const sentAt of [1, null, {}]) {
    expect(() => parseMessageFrame(JSON.stringify({ type: "heartbeat", sentAt }))).toThrow(
      invalidFrame("sentAt must be a string"),
    );
  }
});

test("createHeartbeatFrame stamps the current time as ISO 8601 and type guards are exclusive", () => {
  const before = Date.now();
  const heartbeat = createHeartbeatFrame();
  const after = Date.now();

  expect(new Date(heartbeat.sentAt!).toISOString()).toStrictEqual(heartbeat.sentAt);
  expect(Date.parse(heartbeat.sentAt!)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(heartbeat.sentAt!)).toBeLessThanOrEqual(after);
  expect(isRequestFrame(heartbeat)).toStrictEqual(false);
  expect(isHeartbeatFrame({ type: "response", requestId: "request-1" })).toStrictEqual(false);
});

test("serializeFrame emits a heartbeat that parseMessageFrame accepts", () => {
  const heartbeat = createHeartbeatFrame();

  expect(parseMessageFrame(serializeFrame(heartbeat))).toStrictEqual(heartbeat);
});

test("outbound response and error frames omit the unused field", () => {
  expect("error" in createResponseFrame("request-1", { statusCode: 200 })).toStrictEqual(false);
  expect(JSON.parse(serializeFrame(createErrorFrame("request-1", { code: "X", message: "m" })))).not.toHaveProperty(
    "response",
  );
});
