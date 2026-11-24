import type { Duplex } from "node:stream";
import { getGlobalDispatcher } from "undici";
import { type AccessTokenOptions, generateAccessToken } from "./access-token.ts";
import type { ConnectorConfig } from "./config.ts";
import type { ConnectorRuntime } from "./connector.ts";
import type { WebSocketAttachment } from "./connector.ts";
import { captureUpgrade, recordFailure } from "./http-dispatcher.ts";
import type { RuntimeLogger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import type { Fetcher } from "./outbound-url-policy.ts";
import { createHeartbeatFrame, serializeFrame } from "./protocol.ts";
import { createRuntimeStatus, type RuntimeStatus } from "./runtime-status.ts";

type OpenOutcome = {
  /** True if the socket stayed open longer than the stable threshold. */
  stableOpen: boolean;
};

/**
 * Time the peer has to answer the connector's close frame before the
 * connection is destroyed. Without this, a peer that never answers keeps the
 * old connection open, and frames it still sends there are silently dropped.
 */
export const closeHandshakeTimeoutMs = 1_000;
const normalClosureCode = 1_000;

/**
 * Owns one resilient connection generation and replaces it when a hot-reload
 * changes socket-level YAML settings. Forwarding-only changes do not disturb
 * the active connection.
 */
export class ReloadableWebSocketClient {
  private generationAbort?: AbortController;
  private config: ConnectorConfig;
  private readonly runtime: ConnectorRuntime;
  private readonly status: RuntimeStatus;
  private readonly logger: RuntimeLogger;
  private readonly controlPlaneFetch: Fetcher;

  constructor(
    config: ConnectorConfig,
    runtime: ConnectorRuntime,
    status: RuntimeStatus,
    logger: RuntimeLogger,
    controlPlaneFetch: Fetcher = globalThis.fetch,
  ) {
    this.config = config;
    this.runtime = runtime;
    this.status = status;
    this.logger = logger;
    this.controlPlaneFetch = controlPlaneFetch;
  }

  replace(config: ConnectorConfig): void {
    const connectionChanged =
      config.websocketUrl !== this.config.websocketUrl ||
      config.heartbeatIntervalMs !== this.config.heartbeatIntervalMs;
    this.config = config;
    if (connectionChanged) this.generationAbort?.abort();
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const generationAbort = new AbortController();
      this.generationAbort = generationAbort;
      const generationSignal = AbortSignal.any([signal, generationAbort.signal]);

      await runCloudWebSocketClient(
        this.config,
        this.runtime,
        generationSignal,
        this.status,
        this.logger,
        this.controlPlaneFetch,
      );

      if (this.generationAbort === generationAbort) {
        this.generationAbort = undefined;
      }
      if (!signal.aborted && !generationAbort.signal.aborted) {
        this.logger.error("Cloud Connector WebSocket client exited unexpectedly; restarting");
        await delay(1_000, signal);
      }
    }
  }
}

/**
 * Maintains the outbound cloud WebSocket connection forever.
 *
 * This function is intentionally un-rejectable: every fault inside the loop is
 * caught and turned into a backoff + retry. It only returns when the supplied
 * signal is aborted (graceful shutdown). The connection is rebuilt with
 * exponential backoff + jitter, and a peer-liveness watchdog force-closes a
 * half-open ("wedged") socket so the loop can reconnect.
 */
export async function runCloudWebSocketClient(
  config: ConnectorConfig,
  runtime: ConnectorRuntime,
  signal: AbortSignal,
  status: RuntimeStatus = createRuntimeStatus(),
  logger: RuntimeLogger = createLogger(config.logLevel),
  controlPlaneFetch: Fetcher = globalThis.fetch,
): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    status.lastTickAt = Date.now();
    status.connectionState = "connecting";
    status.reconnectAttempt = attempt;

    try {
      logger.info(`Opening Cloud Connector WebSocket (attempt ${attempt + 1})`);
      const outcome = await openWebSocket(config, runtime, signal, status, logger, controlPlaneFetch);
      attempt = outcome.stableOpen ? 0 : attempt + 1;
    } catch (error) {
      attempt += 1;
      logger.error("Cloud Connector WebSocket failed", error);
    } finally {
      status.connectionState = "disconnected";
    }

    if (signal.aborted) {
      break;
    }

    try {
      const backoff = computeBackoffDelay(
        attempt,
        config.reconnectInitialDelayMs,
        config.reconnectMaxDelayMs,
        config.reconnectJitterRatio,
      );
      logger.info(`Reconnecting Cloud Connector WebSocket in ${backoff}ms`);
      await delay(backoff, signal);
    } catch (error) {
      logger.error("Cloud Connector reconnect delay failed", error);
    }
  }
}

/**
 * Computes the next reconnect delay using capped exponential backoff with
 * equal jitter. Pure and deterministic given `rng`, so it is unit-testable.
 *
 * - attempt <= 0 returns 0 (reconnect immediately after a stable connection).
 * - The exponent is clamped so the math never overflows to Infinity.
 * - jitterRatio is clamped to [0, 1]; 0 yields the deterministic capped delay.
 */
export function computeBackoffDelay(
  attempt: number,
  initialMs: number,
  maxMs: number,
  jitterRatio: number,
  rng: () => number = Math.random,
): number {
  if (attempt <= 0) {
    return 0;
  }

  const exponent = Math.min(attempt - 1, 30);
  const cap = Math.min(initialMs * 2 ** exponent, maxMs);
  const ratio = Math.min(Math.max(jitterRatio, 0), 1);
  const floor = cap * (1 - ratio);

  return Math.round(floor + rng() * (cap - floor));
}

async function openWebSocket(
  config: ConnectorConfig,
  runtime: ConnectorRuntime,
  signal: AbortSignal,
  status: RuntimeStatus,
  logger: RuntimeLogger,
  controlPlaneFetch: Fetcher,
): Promise<OpenOutcome> {
  const accessToken = await generateAccessToken(getAccessTokenOptions(config, signal, controlPlaneFetch));

  return new Promise<OpenOutcome>((resolve, reject) => {
    // The signal may have been aborted while the token was being fetched.
    // Adding an abort listener now would never fire (the transition already
    // happened), so bail out immediately to avoid a hung promise.
    if (signal.aborted) {
      reject(new Error("Cloud Connector shutting down before connect"));
      return;
    }

    let failure: string | undefined;
    let connection: Duplex | undefined;
    const socket = new WebSocket(config.websocketUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      dispatcher: getGlobalDispatcher().compose(
        recordFailure((reason) => (failure = reason)),
        captureUpgrade((upgraded) => (connection = upgraded)),
      ),
    });
    const attachment: WebSocketAttachment = runtime.attachWebSocket(socket);

    let opened = false;
    let openedAt = 0;
    let settled = false;
    let heartbeatId: ReturnType<typeof setInterval> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let closeHandshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let closeRequested = false;

    const isStableOpen = () => opened && Date.now() - openedAt >= config.reconnectStableThresholdMs;
    const clearHeartbeat = () => {
      if (heartbeatId !== undefined) {
        clearInterval(heartbeatId);
        heartbeatId = undefined;
      }
    };
    const destroyConnection = () => {
      closeHandshakeTimer = undefined;
      const timedOut = `Cloud Connector WebSocket close handshake did not complete within ${closeHandshakeTimeoutMs}ms`;
      if (connection === undefined) {
        // Nothing can end a connection that was not captured, so make the
        // possible leak visible instead of claiming it was closed.
        logger.warn(`${timedOut}, and no upgraded connection was captured to close`);
      } else {
        logger.warn(`${timedOut}; closing the connection`);
        connection.destroy();
      }
      settle({ stableOpen: isStableOpen() });
    };
    /**
     * Stops accepting requests, waits up to `drainTimeoutMs` for in-flight
     * requests, and closes the socket. A peer that does not answer the close
     * frame in time loses the connection instead of keeping it open.
     */
    const closeSocket = (reason: string, drainTimeoutMs: number) => {
      if (closeRequested) return;
      closeRequested = true;
      status.connectionState = "disconnected";
      clearHeartbeat();
      void attachment
        .drain(drainTimeoutMs)
        .then((drained) => {
          if (!drained && drainTimeoutMs > 0) {
            logger.warn(`Cloud Connector drain timed out after ${drainTimeoutMs}ms`);
          }
          try {
            socket.close(normalClosureCode, reason);
          } catch {
            // already closing/closed
          }
          if (!settled) {
            closeHandshakeTimer = setTimeout(destroyConnection, closeHandshakeTimeoutMs);
          }
        })
        .catch(fail);
    };
    const abort = () => closeSocket("Cloud Connector closing", config.drainTimeoutMs);

    function cleanup(): void {
      clearHeartbeat();
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      if (closeHandshakeTimer !== undefined) {
        clearTimeout(closeHandshakeTimer);
        closeHandshakeTimer = undefined;
      }
      signal.removeEventListener("abort", abort);
    }

    function settle(outcome: OpenOutcome): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    }

    function fail(error: unknown): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    signal.addEventListener("abort", abort, { once: true });

    connectTimer = setTimeout(() => {
      if (!opened) {
        try {
          socket.close();
        } catch {
          // already closing/closed
        }
        fail(new Error(`Cloud Connector WebSocket did not open within ${config.connectTimeoutMs}ms`));
      }
    }, config.connectTimeoutMs);

    // Any inbound frame proves the peer is alive.
    socket.addEventListener("message", () => {
      const now = Date.now();
      status.lastInboundAt = now;
      status.lastTickAt = now;
    });

    socket.addEventListener("open", () => {
      opened = true;
      openedAt = Date.now();
      status.connectionState = "open";
      status.lastConnectedAt = openedAt;
      status.lastInboundAt = openedAt;
      status.lastTickAt = openedAt;
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }

      heartbeatId = setInterval(() => {
        // The whole body is guarded: an uncaught throw in a timer
        // callback is not awaited and would surface as a global error.
        try {
          const now = Date.now();
          status.lastTickAt = now;

          if (socket.readyState === WebSocket.OPEN) {
            logger.info("Sending Cloud Connector heartbeat");
            socket.send(serializeFrame(createHeartbeatFrame()));
          } else if (socket.readyState === WebSocket.CLOSING) {
            // The platform sent a close frame and Node answered it, so no
            // response can reach the platform anymore. Node now waits for the
            // platform to end the connection, without a time limit.
            closeSocket("Cloud Connector closing", 0);
            return;
          }

          if (config.heartbeatTimeoutFactor > 0) {
            const lastInbound = status.lastInboundAt ?? openedAt;
            const silentFor = now - lastInbound;
            const limit = config.heartbeatIntervalMs * config.heartbeatTimeoutFactor;
            if (silentFor > limit) {
              logger.warn(`Cloud Connector WebSocket silent for ${silentFor}ms; reconnecting`);
              // A silent peer receives no responses, so reconnect without draining.
              closeSocket("Cloud Connector peer silent", 0);
            }
          }
        } catch {
          // Sending or any unexpected fault: force a reconnect.
          closeSocket("Cloud Connector heartbeat failed", config.drainTimeoutMs);
        }
      }, config.heartbeatIntervalMs);
    });

    socket.addEventListener("error", (event) => {
      if (!opened) {
        fail(
          new Error(`Unable to open Cloud Connector WebSocket${failure ? `: ${failure}` : ""}`, {
            cause: event,
          }),
        );
      }
      // If already open, wait for the "close" event to settle the promise.
    });

    socket.addEventListener("close", () => {
      settle({ stableOpen: isStableOpen() });
    });
  });
}

function getAccessTokenOptions(config: ConnectorConfig, signal: AbortSignal, fetcher: Fetcher): AccessTokenOptions {
  return {
    host: config.cloudConnectorHost,
    clientId: config.cloudConnectorClientId,
    clientSecret: config.cloudConnectorClientSecret,
    timeoutMs: config.tokenFetchTimeoutMs,
    signal,
    fetcher,
  };
}

/** Resolves after `ms`, or immediately when the signal is aborted. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeoutId);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
