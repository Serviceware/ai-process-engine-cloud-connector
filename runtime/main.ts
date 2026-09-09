import { ConfigReloader, watchConfigFile } from "./config-reloader.ts";
import {
  combineConfig,
  type ConnectorConfig,
  connectorListenHost,
  connectorListenPort,
  defaultConfigPath,
  type EnvironmentConfig,
  loadEnvironmentConfig,
  loadVolumeConfig,
} from "./config.ts";
import {
  ConnectorRuntime,
  type ProtocolExecutor,
  ReloadableProtocolExecutor,
} from "./connector.ts";
import type { ReloadableRuntimeLogger, RuntimeLogger } from "./logger.ts";
import { createLogger, createReloadableLogger } from "./logger.ts";
import { fetchWithoutOutboundUrlPolicy } from "./outbound-url-policy.ts";
import { createRuntimeStatus, type RuntimeStatus } from "./runtime-status.ts";
import { delay, ReloadableWebSocketClient } from "./websocket-client.ts";
import { createYamlForwardingExecutor } from "./yaml-forwarding.ts";

/** Exit codes (sysexits.h) so a supervisor can distinguish failure modes. */
const EX_SOFTWARE = 70;
const EX_OSERR = 71;
const EX_CONFIG = 78;

export function createProtocolExecutor(
  config: ConnectorConfig,
  configPath: string,
  logger: RuntimeLogger = createLogger(config.logLevel),
): Promise<ProtocolExecutor> {
  return createYamlForwardingExecutor({ config, configPath, logger });
}

export type RuntimeBundle = {
  runtime: ConnectorRuntime;
  protocolExecutor: ReloadableProtocolExecutor;
};

export async function createRuntimeBundle(
  config: ConnectorConfig,
  configPath: string,
  logger: RuntimeLogger = createLogger(config.logLevel),
): Promise<RuntimeBundle> {
  logger.info("Starting Cloud Connector forward proxy");
  const initialExecutor = await createProtocolExecutor(
    config,
    configPath,
    logger,
  );
  const protocolExecutor = new ReloadableProtocolExecutor(initialExecutor);
  const runtime = new ConnectorRuntime({ protocolExecutor, logger });
  return { runtime, protocolExecutor };
}

export async function createRuntime(
  config: ConnectorConfig,
  configPath: string,
  logger: RuntimeLogger = createLogger(config.logLevel),
): Promise<ConnectorRuntime> {
  return (await createRuntimeBundle(config, configPath, logger)).runtime;
}

export function createHandler(
  environment: EnvironmentConfig,
  status: RuntimeStatus,
  now: () => number = Date.now,
): (request: Request) => Response {
  return (request) => {
    const url = new URL(request.url);

    // Liveness covers the in-process supervision loop, not cloud availability.
    if (url.pathname === "/health") {
      const stale = now() - status.lastTickAt > environment.livenessStaleMs;
      if (stale) {
        return Response.json(
          { status: "unhealthy", reason: "supervision loop stalled" },
          { status: 503 },
        );
      }
      return Response.json({ status: "ok" });
    }

    // The forward proxy is ready only while its outbound cloud socket is open.
    if (url.pathname === "/ready") {
      const websocketConnected = status.connectionState === "open";
      return Response.json(
        {
          status: websocketConnected ? "ready" : "not_ready",
          websocketConnected,
        },
        { status: websocketConnected ? 200 : 503 },
      );
    }

    return new Response("Not found", { status: 404 });
  };
}

/**
 * Runs a task forever and recreates it if it fails while the process is live.
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

/** Rebinds the fixed local probe server if it stops unexpectedly. */
async function superviseHttpServer(
  initial: Deno.HttpServer,
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
        {
          hostname: connectorListenHost,
          port: connectorListenPort,
          signal,
        },
        handler,
      );
    } catch (error) {
      server = undefined;
      logger.error("Failed to rebind HTTP server", error);
    }
  }
}

function logOutboundPolicy(
  config: ConnectorConfig,
  logger: RuntimeLogger,
): void {
  const patterns = config.forwarding.outboundUrlAllowlist.length;
  logger.info(
    patterns === 0
      ? "YAML outbound URL allowlist is empty; all workload HTTP requests are blocked"
      : `YAML outbound URL allowlist active with ${patterns} pattern(s)`,
  );
}

// Main entry point
if (import.meta.main) {
  let startupComplete = false;
  let shuttingDown = false;

  globalThis.addEventListener("unhandledrejection", (event) => {
    if (!startupComplete) return;
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

  const configPath = Deno.args[0] ?? defaultConfigPath;
  let environment: EnvironmentConfig;
  let config: ConnectorConfig;
  let logger: ReloadableRuntimeLogger;
  try {
    environment = loadEnvironmentConfig();
    config = combineConfig(environment, await loadVolumeConfig(configPath));
    logger = createReloadableLogger(config.logLevel);
    logOutboundPolicy(config, logger);
  } catch (error) {
    console.error(
      "[cloud-connector] FATAL: invalid configuration:",
      error instanceof Error ? error.message : error,
    );
    Deno.exit(EX_CONFIG);
  }

  let runtimeBundle: RuntimeBundle;
  try {
    runtimeBundle = await createRuntimeBundle(config, configPath, logger);
  } catch (error) {
    console.error(
      "[cloud-connector] FATAL: failed to initialize forward proxy:",
      error,
    );
    Deno.exit(EX_SOFTWARE);
  }

  const status = createRuntimeStatus();
  const abortController = new AbortController();
  const handler = createHandler(environment, status);
  const websocketClient = new ReloadableWebSocketClient(
    config,
    runtimeBundle.runtime,
    status,
    logger,
    fetchWithoutOutboundUrlPolicy,
  );

  const configReloader = new ConfigReloader(
    configPath,
    environment,
    async (nextConfig) => {
      // Construct every fallible component before changing live state.
      const nextExecutor = await createProtocolExecutor(
        nextConfig,
        configPath,
        logger,
      );

      runtimeBundle.protocolExecutor.replace(nextExecutor);
      logger.setLevel(nextConfig.logLevel);
      websocketClient.replace(nextConfig);
      config = nextConfig;
      logOutboundPolicy(config, logger);
    },
    logger,
  );

  // First bind is fatal: a port conflict is unrecoverable in-process.
  let server: Deno.HttpServer;
  try {
    server = Deno.serve(
      {
        hostname: connectorListenHost,
        port: connectorListenPort,
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

  await Promise.all([
    superviseHttpServer(
      server,
      handler,
      abortController.signal,
      logger,
    ),
    superviseTask(
      "websocket-client",
      () => websocketClient.run(abortController.signal),
      abortController.signal,
      logger,
    ),
    superviseTask(
      "config-watcher",
      () =>
        watchConfigFile(
          configPath,
          configReloader,
          abortController.signal,
        ),
      abortController.signal,
      logger,
    ),
  ]);
}
