import type {
  CloudConnectorHeartbeatFrame,
  CloudConnectorMessageFrame,
  CloudConnectorRequestFrame,
  CloudConnectorResponseFrame,
} from "./generated/models.ts";
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
