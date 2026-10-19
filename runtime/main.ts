import type { Server } from "node:http";
import { setGlobalDispatcher } from "undici";
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
import { ConnectorRuntime, type ProtocolExecutor, ReloadableProtocolExecutor } from "./connector.ts";
import { createHttpDispatcher } from "./http-dispatcher.ts";
import { serve } from "./http-server.ts";
import type { ReloadableRuntimeLogger, RuntimeLogger } from "./logger.ts";
import { createLogger, createReloadableLogger } from "./logger.ts";
import { fetchWithoutOutboundUrlPolicy } from "./outbound-url-policy.ts";
import { createRuntimeStatus, type RuntimeStatus } from "./runtime-status.ts";
import { delay, ReloadableWebSocketClient } from "./websocket-client.ts";
import { createOAuthTokenCache, createYamlForwardingExecutor, type OAuthTokenCache } from "./yaml-forwarding.ts";

/** Exit codes (sysexits.h) so a supervisor can distinguish failure modes. */
const EX_SOFTWARE = 70;
const EX_OSERR = 71;
const EX_CONFIG = 78;
const shutdownGraceMs = 2_000;

export function createProtocolExecutor(
  config: ConnectorConfig,
  configPath: string,
  logger: RuntimeLogger = createLogger(config.logLevel),
  oauthTokenCache: OAuthTokenCache = createOAuthTokenCache(),
): Promise<ProtocolExecutor> {
  return createYamlForwardingExecutor({
    config,
    configPath,
    logger,
    oauthTokenCache,
  });
}

export type RuntimeBundle = {
  runtime: ConnectorRuntime;
  protocolExecutor: ReloadableProtocolExecutor;
  oauthTokenCache: OAuthTokenCache;
};

export async function createRuntimeBundle(
  config: ConnectorConfig,
  configPath: string,
  logger: RuntimeLogger = createLogger(config.logLevel),
): Promise<RuntimeBundle> {
  logger.info("Starting Cloud Connector forward proxy");
  const oauthTokenCache = createOAuthTokenCache();
  const initialExecutor = await createProtocolExecutor(config, configPath, logger, oauthTokenCache);
  const protocolExecutor = new ReloadableProtocolExecutor(initialExecutor);
  const runtime = new ConnectorRuntime({
    protocolExecutor,
    logger,
    maximumConcurrentRequests: config.maxConcurrentRequests,
  });
  return { runtime, protocolExecutor, oauthTokenCache };
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
        return Response.json({ status: "unhealthy", reason: "supervision loop stalled" }, { status: 503 });
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
          connectionState: status.connectionState,
          reconnectAttempt: status.reconnectAttempt,
          lastConnectedAt: status.lastConnectedAt,
          lastInboundAt: status.lastInboundAt,
          configReload: {
            lastAttemptAt: status.lastReloadAt,
            succeeded: status.lastReloadSucceeded,
          },
        },
        { status: websocketConnected ? 200 : 503 },
      );
    }

    return new Response("Not found", { status: 404 });
  };
}

function serveProbes(
  handler: (request: Request) => Response,
  signal: AbortSignal,
  logger: RuntimeLogger,
): Promise<Server> {
  return serve(handler, {
    hostname: connectorListenHost,
    port: connectorListenPort,
    signal,
    logger,
  });
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
export async function superviseHttpServer(
  initial: Server,
  rebind: () => Promise<Server>,
  signal: AbortSignal,
  logger: RuntimeLogger,
): Promise<void> {
  let server: Server | undefined = initial;
  while (!signal.aborted) {
    if (server !== undefined) {
      // serve() logs server errors; only a close ends this server.
      if (server.listening) await closed(server);
      if (signal.aborted) break;
      logger.error("HTTP server stopped unexpectedly; rebinding");
    }

    await delay(1_000, signal);
    if (signal.aborted) break;

    try {
      server = await rebind();
    } catch (error) {
      server = undefined;
      logger.error("Failed to rebind HTTP server", error);
    }
  }
}

function closed(server: Server): Promise<void> {
  return new Promise((resolve) => server.once("close", () => resolve()));
}

function logOutboundPolicy(config: ConnectorConfig, logger: RuntimeLogger): void {
  const patterns = config.forwarding.length;
  logger.info(`YAML forwarding policy active with ${patterns} target rule(s)`);
}

// Main entry point
if (import.meta.main) {
  let shuttingDown = false;
  setGlobalDispatcher(createHttpDispatcher());

  const configPath = process.argv[2] ?? defaultConfigPath;
  let environment: EnvironmentConfig;
  let config: ConnectorConfig;
  let logger: ReloadableRuntimeLogger;
  try {
    environment = loadEnvironmentConfig();
    config = combineConfig(environment, await loadVolumeConfig(configPath));
    logger = createReloadableLogger(config.logLevel);
    logOutboundPolicy(config, logger);
  } catch (error) {
    console.error("[cloud-connector] FATAL: invalid configuration:", error instanceof Error ? error.message : error);
    process.exit(EX_CONFIG);
  }

  let runtimeBundle: RuntimeBundle;
  try {
    runtimeBundle = await createRuntimeBundle(config, configPath, logger);
  } catch (error) {
    console.error("[cloud-connector] FATAL: failed to initialize forward proxy:", error);
    process.exit(EX_SOFTWARE);
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
      const nextExecutor = await createProtocolExecutor(nextConfig, configPath, logger, runtimeBundle.oauthTokenCache);

      runtimeBundle.protocolExecutor.replace(nextExecutor);
      logger.setLevel(nextConfig.logLevel);
      websocketClient.replace(nextConfig);
      config = nextConfig;
      logOutboundPolicy(config, logger);
    },
    logger,
    status,
  );

  // First bind is fatal: a port conflict is unrecoverable in-process.
  let server: Server;
  try {
    server = await serveProbes(handler, abortController.signal, logger);
  } catch (error) {
    console.error("[cloud-connector] FATAL: cannot bind HTTP server:", error);
    process.exit(EX_OSERR);
  }

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    abortController.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Before this point an unexpected fault terminates startup.
  process.on("unhandledRejection", (reason) => {
    try {
      console.error("[cloud-connector] unhandled rejection (recovered):", reason);
    } catch {
      /* never let logging terminate the process */
    }
  });
  process.on("uncaughtException", (error) => {
    try {
      console.error("[cloud-connector] uncaught error (recovered):", error);
    } catch {
      /* never let logging terminate the process */
    }
  });

  await Promise.all([
    superviseHttpServer(
      server,
      () => serveProbes(handler, abortController.signal, logger),
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
      () => watchConfigFile(configPath, configReloader, abortController.signal),
      abortController.signal,
      logger,
    ),
  ]);
  // A WebSocket whose peer never answers the close frame keeps its socket open.
  setTimeout(() => process.exit(0), shutdownGraceMs).unref();
}
