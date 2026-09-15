import type {
  CloudConnectorHeartbeatFrame,
  CloudConnectorMessageFrame,
  CloudConnectorRequestFrame,
  CloudConnectorResponseFrame,
} from "./generated/models.ts";
import { CLOUD_CONNECTOR_HTTP_METHOD_VALUES } from "./generated/models.ts";
import { RuntimeError } from "./runtime-error.ts";

export type WritableFrame =
  | CloudConnectorResponseFrame
  | CloudConnectorHeartbeatFrame;

export function parseMessageFrame(data: unknown): CloudConnectorMessageFrame {
  if (typeof data !== "string") {
    throw new RuntimeError(
      "INVALID_FRAME",
      "WebSocket frames must be JSON strings",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new RuntimeError(
      "INVALID_FRAME",
      "WebSocket frame is not valid JSON",
      { cause: error },
    );
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new RuntimeError(
      "INVALID_FRAME",
      "WebSocket frame must contain a string type",
    );
  }

  if (
    parsed.type !== "request" && parsed.type !== "response" &&
    parsed.type !== "heartbeat"
  ) {
    throw new RuntimeError(
      "UNSUPPORTED_FRAME",
      `Unsupported frame type: ${parsed.type}`,
    );
  }

  if (parsed.type === "request") validateRequestFrame(parsed);
  if (parsed.type === "response") validateResponseFrame(parsed);
  if (
    parsed.type === "heartbeat" && parsed.sentAt !== undefined &&
    typeof parsed.sentAt !== "string"
  ) {
    invalidFrame("Heartbeat frame sentAt must be a string when present");
  }

  return parsed as CloudConnectorMessageFrame;
}

export function isRequestFrame(
  frame: CloudConnectorMessageFrame,
): frame is CloudConnectorRequestFrame {
  return frame.type === "request";
}

export function isHeartbeatFrame(
  frame: CloudConnectorMessageFrame,
): frame is CloudConnectorHeartbeatFrame {
  return frame.type === "heartbeat";
}

export function createHeartbeatFrame(): CloudConnectorHeartbeatFrame {
  return {
    type: "heartbeat",
    sentAt: new Date().toISOString(),
  };
}

export function createResponseFrame(
  requestId: string,
  response: CloudConnectorResponseFrame["response"],
): CloudConnectorResponseFrame {
  return {
    type: "response",
    requestId,
    response,
  };
}

export function createErrorFrame(
  requestId: string,
  error: CloudConnectorResponseFrame["error"],
): CloudConnectorResponseFrame {
  return {
    type: "response",
    requestId,
    error,
  };
}

export function serializeFrame(frame: WritableFrame): string {
  return JSON.stringify(frame);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRequestFrame(frame: Record<string, unknown>): void {
  requireRequestId(frame);
  if (!isRecord(frame.request)) {
    invalidFrame("Request frame must contain a request object");
  }
  const request = frame.request as Record<string, unknown>;
  if (
    typeof request.method !== "string" ||
    !CLOUD_CONNECTOR_HTTP_METHOD_VALUES.includes(
      request.method as (typeof CLOUD_CONNECTOR_HTTP_METHOD_VALUES)[number],
    )
  ) {
    invalidFrame("Request frame must contain a supported request.method");
  }
  if (typeof request.url !== "string" || !request.url) {
    invalidFrame("Request frame must contain a non-empty request.url");
  }
  if (request.headers !== undefined) {
    if (!isRecord(request.headers)) {
      invalidFrame("Request frame request.headers must be an object");
    }
    for (const value of Object.values(request.headers)) {
      if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string")
      ) {
        invalidFrame("Request frame header values must be arrays of strings");
      }
    }
  }
  if (
    request.body !== undefined && request.body !== null &&
    typeof request.body !== "string"
  ) {
    invalidFrame("Request frame request.body must be a string or null");
  }
  if (
    request.timeoutSeconds !== undefined &&
    (typeof request.timeoutSeconds !== "number" ||
      !Number.isInteger(request.timeoutSeconds) ||
      request.timeoutSeconds < 1 || request.timeoutSeconds > 90)
  ) {
    invalidFrame(
      "Request frame request.timeoutSeconds must be an integer from 1 to 90",
    );
  }
}

function validateResponseFrame(frame: Record<string, unknown>): void {
  requireRequestId(frame);
  if (frame.response !== undefined) {
    if (!isRecord(frame.response)) {
      invalidFrame("Response frame response must be an object");
    }
    const statusCode = (frame.response as Record<string, unknown>).statusCode;
    if (
      typeof statusCode !== "number" || !Number.isInteger(statusCode) ||
      statusCode < 100 || statusCode > 599
    ) {
      invalidFrame(
        "Response frame response.statusCode must be an HTTP status code",
      );
    }
  }
  if (frame.error !== undefined) {
    if (!isRecord(frame.error)) {
      invalidFrame("Response frame error must be an object");
    }
    const error = frame.error as Record<string, unknown>;
    if (typeof error.code !== "string" || typeof error.message !== "string") {
      invalidFrame(
        "Response frame error must contain string code and message fields",
      );
    }
  }
}

function requireRequestId(frame: Record<string, unknown>): void {
  if (typeof frame.requestId !== "string" || !frame.requestId) {
    invalidFrame("WebSocket frame must contain a non-empty requestId");
  }
}

function invalidFrame(message: string): never {
  throw new RuntimeError("INVALID_FRAME", message);
}
