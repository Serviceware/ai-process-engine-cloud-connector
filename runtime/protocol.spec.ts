import { assertEquals, assertThrows } from "@std/assert";
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
import { RuntimeError } from "./runtime-error.ts";

Deno.test("parseMessageFrame parses request and heartbeat frames", () => {
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

    assertEquals(isRequestFrame(parsedRequest), true);
    assertEquals(isHeartbeatFrame(parsedHeartbeat), true);
    assertEquals(parsedRequest, requestFrame);
    assertEquals(parsedHeartbeat, heartbeatFrame);
});

Deno.test("parseMessageFrame rejects malformed frames", () => {
    assertThrows(
        () => parseMessageFrame(new Uint8Array()),
        RuntimeError,
        "WebSocket frames must be JSON strings",
    );
    assertThrows(
        () => parseMessageFrame("{"),
        RuntimeError,
        "WebSocket frame is not valid JSON",
    );
    assertThrows(
        () => parseMessageFrame("{}"),
        RuntimeError,
        "WebSocket frame must contain a string type",
    );
    assertThrows(
        () => parseMessageFrame('{"type":"unknown"}'),
        RuntimeError,
        "Unsupported frame type: unknown",
    );
});

Deno.test("frame factories create serializable outbound frames", () => {
    const heartbeat = createHeartbeatFrame();
    const response = createResponseFrame("request-1", {
        statusCode: 204,
        headers: { "x-test": ["ok"] },
    });
    const error = createErrorFrame("request-2", {
        code: "FAILED",
        message: "Request failed",
    });

    assertEquals(heartbeat.type, "heartbeat");
    assertEquals(response, {
        type: "response",
        requestId: "request-1",
        response: { statusCode: 204, headers: { "x-test": ["ok"] } },
    });
    assertEquals(error, {
        type: "response",
        requestId: "request-2",
        error: { code: "FAILED", message: "Request failed" },
    });
    assertEquals(serializeFrame(error), JSON.stringify(error));
});
