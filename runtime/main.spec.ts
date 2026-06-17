import { assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "./config.ts";
import { ConnectorRuntime, type ProtocolExecutor } from "./connector.ts";
import type {
    CloudConnectorMessageFrame,
    CloudConnectorRequestFrame,
} from "./generated/models.ts";
import { createLogger } from "./logger.ts";
import { createHandler, createProtocolExecutor } from "./main.ts";
import type { WritableFrame } from "./protocol.ts";
import { RuntimeError } from "./runtime-error.ts";
import { createRuntimeStatus } from "./runtime-status.ts";

const requestId = "00000000-0000-0000-0000-000000000001";
const silentLogger = createLogger("error", {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
});

const cloudConfig = () =>
    loadConfig({
        CLOUD_CONNECTOR_WS_URL: "wss://cloud.example/ws",
        CLOUD_CONNECTOR_HOST: "https://cloud.example/",
        CLOUD_CONNECTOR_CLIENT_ID: "client-id",
        CLOUD_CONNECTOR_CLIENT_SECRET: "client-secret",
    });

Deno.test("health stays ok and ws upgrade is required", async () => {
    const config = cloudConfig();
    const status = createRuntimeStatus();
    const handler = createHandler(createPassthroughRuntime(), config, status);

    const healthResponse = handler(new Request("http://localhost/health"));
    assertEquals(healthResponse.status, 200);
    assertEquals(await healthResponse.json(), { status: "ok" });
    assertEquals(handler(new Request("http://localhost/ws")).status, 426);
});

Deno.test("ready reflects the real WebSocket connection state", async () => {
    const config = cloudConfig();
    const status = createRuntimeStatus();
    const handler = createHandler(createPassthroughRuntime(), config, status);

    // Disconnected while a WS is configured => not ready (503).
    const notReady = handler(new Request("http://localhost/ready"));
    assertEquals(notReady.status, 503);
    assertEquals(await notReady.json(), {
        status: "not_ready",
        websocketConfigured: true,
        websocketConnected: false,
    });

    // Connected => ready (200).
    status.connectionState = "open";
    const ready = handler(new Request("http://localhost/ready"));
    assertEquals(ready.status, 200);
    assertEquals(await ready.json(), {
        status: "ready",
        websocketConfigured: true,
        websocketConnected: true,
    });
});

Deno.test("ready is true when no WebSocket is configured (pure HTTP mode)", async () => {
    const config = loadConfig({});
    const status = createRuntimeStatus();
    const handler = createHandler(createPassthroughRuntime(), config, status);

    const ready = handler(new Request("http://localhost/ready"));
    assertEquals(ready.status, 200);
    assertEquals(await ready.json(), {
        status: "ready",
        websocketConfigured: false,
        websocketConnected: false,
    });
});

Deno.test("health fails only when the supervision loop is stale", async () => {
    const config = cloudConfig();
    const status = createRuntimeStatus(0);
    let clock = 0;
    const handler = createHandler(
        createPassthroughRuntime(),
        config,
        status,
        () => clock,
    );

    // Within the liveness window (and even while disconnected) => healthy.
    clock = config.livenessStaleMs;
    status.connectionState = "disconnected";
    assertEquals(handler(new Request("http://localhost/health")).status, 200);

    // Loop tick stale beyond the window => unhealthy so the supervisor restarts.
    clock = config.livenessStaleMs + 1;
    const stale = handler(new Request("http://localhost/health"));
    assertEquals(stale.status, 503);
    assertEquals((await stale.json()).status, "unhealthy");
});

Deno.test("validates configured URL protocols", () => {
    assertThrows(
        () => loadConfig({ CLOUD_CONNECTOR_WS_URL: "https://cloud.example/ws" }),
        Error,
        "CLOUD_CONNECTOR_WS_URL must use one of these protocols: ws:, wss:",
    );
});

Deno.test("runs protocol executor for request frames", async () => {
    const sentFrames: WritableFrame[] = [];
    let executedUrl: string | undefined;
    const runtime = new ConnectorRuntime({
        protocolExecutor: {
            execute: (frame: CloudConnectorRequestFrame) => {
                executedUrl = frame.request.url;
                return Promise.resolve({
                    statusCode: 201,
                    headers: { "x-function": ["ok"] },
                    body: `called:${frame.request.url}`,
                });
            },
        } as unknown as ProtocolExecutor,
        logger: silentLogger,
    });
    const frame: CloudConnectorMessageFrame = {
        type: "request",
        requestId,
        request: {
            method: "POST",
            url: "/internal/orders",
            body: "payload",
        },
    };

    await runtime.handleFrame(frame, (sentFrame) => {
        sentFrames.push(sentFrame);
    });

    assertEquals(executedUrl, "/internal/orders");
    assertEquals(sentFrames, [{
        type: "response",
        requestId,
        response: {
            statusCode: 201,
            headers: { "x-function": ["ok"] },
            body: "called:/internal/orders",
        },
    }]);
});

Deno.test("responds to heartbeat frames with heartbeat", async () => {
    const sentFrames: WritableFrame[] = [];
    const runtime = createPassthroughRuntime();
    const heartbeatFrame: CloudConnectorMessageFrame = {
        type: "heartbeat",
        sentAt: "2024-01-01T00:00:00.000Z",
    };

    await runtime.handleFrame(heartbeatFrame, (frame) => {
        sentFrames.push(frame);
    });

    assertEquals(sentFrames.length, 1);
    assertEquals(sentFrames[0].type, "heartbeat");
});

Deno.test("sends error frame when function router throws", async () => {
    const sentFrames: WritableFrame[] = [];
    const runtime = new ConnectorRuntime({
        protocolExecutor: {
            execute: () => {
                throw new RuntimeError(
                    "FUNCTION_REJECTED",
                    "Request rejected by function",
                );
            },
        } as unknown as ProtocolExecutor,
        logger: silentLogger,
    });
    const frame: CloudConnectorMessageFrame = {
        type: "request",
        requestId,
        request: { method: "GET", url: "/test" },
    };

    await runtime.handleFrame(frame, (sentFrame) => {
        sentFrames.push(sentFrame);
    });

    assertEquals(sentFrames.length, 1);
    assertEquals(sentFrames[0].type, "response");
    assertEquals(
        (sentFrames[0] as { error?: { code: string } }).error?.code,
        "FUNCTION_REJECTED",
    );
});

Deno.test("createProtocolExecutor uses HTTP proxy mode when no functions directory exists", async () => {
    const executor = await createProtocolExecutor(
        loadConfig({ CLOUD_CONNECTOR_FUNCTIONS_DIR: "./does-not-exist" }),
        silentLogger,
    );

    assertEquals(executor.mode, "http-proxy");
});

Deno.test("createProtocolExecutor uses HTTP function mode when the directory has routes", async () => {
    const dir = await Deno.makeTempDir();
    try {
        await Deno.writeTextFile(
            `${dir}/health.ts`,
            "export const GET = () => new Response('ok');\n",
        );
        const executor = await createProtocolExecutor(
            loadConfig({ CLOUD_CONNECTOR_FUNCTIONS_DIR: dir }),
            silentLogger,
        );
        assertEquals(executor.mode, "http-functions");
        assertEquals(executor.routes.map((route) => route.path), ["/health"]);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

function createPassthroughRuntime(): ConnectorRuntime {
    return new ConnectorRuntime({
        protocolExecutor: {
            execute: () => Promise.resolve({ statusCode: 204 }),
        } as unknown as ProtocolExecutor,
        logger: silentLogger,
    });
}
