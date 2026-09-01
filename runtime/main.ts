import type { ConnectorConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { ConnectorRuntime, type ProtocolExecutor } from "./connector.ts";
import type { RuntimeLogger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import { fetchWithoutOutboundUrlPolicy } from "./outbound-url-policy.ts";
import { RuntimeError } from "./runtime-error.ts";
import { createRuntimeStatus, type RuntimeStatus } from "./runtime-status.ts";
import { delay, runCloudWebSocketClient } from "./websocket-client.ts";
import { createYamlForwardingExecutor } from "./yaml-forwarding.ts";

/** Exit codes (sysexits.h) so a supervisor can distinguish failure modes. */
const EX_SOFTWARE = 70;
const EX_OSERR = 71;
const EX_CONFIG = 78;

export function createProtocolExecutor(
  config: ConnectorConfig,
  logger: RuntimeLogger = createLogger(config.logLevel),
): Promise<ProtocolExecutor> {
  return createYamlForwardingExecutor({ config, logger });
}

export type RuntimeBundle = {
  runtime: ConnectorRuntime;
  protocolExecutor: ProtocolExecutor;
};

export async function createRuntimeBundle(
  config: ConnectorConfig,
  logger: RuntimeLogger = createLogger(config.logLevel),
): Promise<RuntimeBundle> {
  logger.info("Starting Edge Connector runtime");
  const protocolExecutor = await createProtocolExecutor(config, logger);
  const runtime = new ConnectorRuntime({
    protocolExecutor,
    logger,
  });
  return { runtime, protocolExecutor };
}

export async function createRuntime(
  config: ConnectorConfig,
  logger: RuntimeLogger = createLogger(config.logLevel),
): Promise<ConnectorRuntime> {
  return (await createRuntimeBundle(config, logger)).runtime;
}

export function createHandler(
  runtime: ConnectorRuntime,
  config: ConnectorConfig,
  status: RuntimeStatus,
  now: () => number = Date.now,
): (request: Request) => Response {
  return (request) => {
    const url = new URL(request.url);

    // Liveness: the process is recoverable. Fails ONLY when the supervision
    // loop has gone stale (truly wedged) — NOT merely while reconnecting.
    if (url.pathname === "/health") {
      const stale = now() - status.lastTickAt > config.livenessStaleMs;
      if (stale) {
        return Response.json(
          { status: "unhealthy", reason: "supervision loop stalled" },
          { status: 503 },
        );
      }
      return Response.json({ status: "ok" });
    }

    // Readiness: the cloud connection is usable right now. 503 while
    // disconnected/reconnecting de-routes traffic without killing the process.
    if (url.pathname === "/ready") {
      const websocketConfigured = config.websocketUrl !== undefined;
      const websocketConnected = status.connectionState === "open";
      // With no WS configured the Edge Connector is a pure HTTP service => ready.
      const ready = !websocketConfigured || websocketConnected;
      return Response.json(
        {
          status: ready ? "ready" : "not_ready",
          websocketConfigured,
          websocketConnected,
        },
        { status: ready ? 200 : 503 },
      );
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }

      const { socket, response } = Deno.upgradeWebSocket(request);
      runtime.attachWebSocket(socket);
      return response;
    }

    return new Response("Not found", { status: 404 });
  };
}

/**
 * Runs `factory` and restarts it (with a small backoff) if it ever settles or
 * throws while the signal is not aborted. The WS client already loops forever
 * internally; this is the outer safety net guaranteeing it is never left dead.
 */
async function superviseTask(
  name: string,
  factory: () => Promise<void>,
  signal: AbortSignal,
  logger: RuntimeLogger,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await factory();
    } catch (error) {
      logger.error(`Task "${name}" crashed`, error);
    }
    if (signal.aborted) break;
    logger.error(`Task "${name}" exited unexpectedly; restarting`);
    await delay(1_000, signal);
  }
}

/**
 * Binds the HTTP server and rebinds it if it ever stops unexpectedly. The first
 * bind is the caller's responsibility (fatal); this supervises rebinds only.
 */
async function superviseHttpServer(
  initial: Deno.HttpServer,
  config: ConnectorConfig,
  handler: (request: Request) => Response,
  signal: AbortSignal,
  logger: RuntimeLogger,
): Promise<void> {
  let server: Deno.HttpServer | undefined = initial;
  while (!signal.aborted) {
    if (server !== undefined) {
      try {
        await server.finished;
      } catch (error) {
        logger.error("HTTP server error", error);
      }
      if (signal.aborted) break;
      logger.error("HTTP server stopped unexpectedly; rebinding");
    }

    await delay(1_000, signal);
    if (signal.aborted) break;

    try {
      server = Deno.serve(
        { hostname: config.host, port: config.port, signal },
        handler,
      );
    } catch (error) {
      // Do not await the stale (finished) server again on the next iteration;
      // keep retrying the rebind on a fixed interval until it succeeds.
      server = undefined;
      logger.error("Failed to rebind HTTP server", error);
    }
  }
}

// Main entry point
if (import.meta.main) {
  // Startup latch: before startup completes, faults are fatal and visible so a
  // broken config/bind crash-loops loudly instead of being silently absorbed.
  // After startup, stray rejections/errors are logged and swallowed so a
  // transient steady-state fault can never terminate the process.
  let startupComplete = false;
  let shuttingDown = false;

  globalThis.addEventListener("unhandledrejection", (event) => {
    if (!startupComplete) return;
    // preventDefault FIRST so the process survives even if logging itself
    // throws (e.g. a broken stdout stream or a throwing error object).
    event.preventDefault();
    try {
      console.error(
        "[cloud-connector] unhandled rejection (recovered):",
        event.reason,
      );
    } catch { /* never let logging terminate the process */ }
  });
  globalThis.addEventListener("error", (event) => {
    if (!startupComplete) return;
    event.preventDefault();
    try {
      console.error(
        "[cloud-connector] uncaught error (recovered):",
        event.error,
      );
    } catch { /* never let logging terminate the process */ }
  });

  let config: ConnectorConfig;
  let logger: RuntimeLogger = createLogger();
  try {
    config = loadConfig();
    logger = createLogger(config.logLevel);
    logger.info(
      config.outboundUrlAllowlist.length === 0
        ? "Outbound URL allowlist is empty; all workload HTTP requests are blocked"
        : `Outbound URL allowlist active with ${config.outboundUrlAllowlist.length} pattern(s)`,
    );
  } catch (error) {
    console.error(
      "[cloud-connector] FATAL: invalid configuration:",
      error instanceof Error ? error.message : error,
    );
    Deno.exit(EX_CONFIG);
  }

  let runtimeBundle: RuntimeBundle;
  try {
    runtimeBundle = await createRuntimeBundle(config, logger);
  } catch (error) {
    const configurationFailure = error instanceof RuntimeError &&
      (error.code === "CONFIG_ERROR" || error.code === "YAML_PARSE_ERROR");
    console.error(
      configurationFailure
        ? "[cloud-connector] FATAL: invalid forwarding configuration:"
        : "[cloud-connector] FATAL: failed to initialize runtime:",
      error,
    );
    Deno.exit(configurationFailure ? EX_CONFIG : EX_SOFTWARE);
  }

  const status = createRuntimeStatus();
  const handler = createHandler(runtimeBundle.runtime, config, status);
  const abortController = new AbortController();

  // First HTTP bind is fatal: a port conflict is unrecoverable in-process.
  let server: Deno.HttpServer;
  try {
    server = Deno.serve(
      {
        hostname: config.host,
        port: config.port,
        signal: abortController.signal,
      },
      handler,
    );
  } catch (error) {
    console.error("[cloud-connector] FATAL: cannot bind HTTP server:", error);
    Deno.exit(EX_OSERR);
  }

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    abortController.abort();
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  startupComplete = true;

  // Supervisors only return on shutdown, keeping the process alive. The WS
  // client is only supervised when a URL is configured; otherwise it returns
  // immediately by design (pure HTTP mode) and must not be restart-looped.
  const tasks: Promise<void>[] = [
    superviseHttpServer(
      server,
      config,
      handler,
      abortController.signal,
      logger,
    ),
  ];
  if (config.websocketUrl) {
    tasks.push(
      superviseTask(
        "websocket-client",
        () =>
          runCloudWebSocketClient(
            config,
            runtimeBundle.runtime,
            abortController.signal,
            status,
            logger,
            fetchWithoutOutboundUrlPolicy,
          ),
        abortController.signal,
        logger,
      ),
    );
  }
  await Promise.all(tasks);
}
