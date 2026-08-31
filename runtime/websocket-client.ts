import {
  type AccessTokenOptions,
  generateAccessToken,
} from "./access-token.ts";
import type { ConnectorConfig } from "./config.ts";
import type { ConnectorRuntime } from "./connector.ts";
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
  if (!config.websocketUrl) {
    return;
  }

  let attempt = 0;
  while (!signal.aborted) {
    status.lastTickAt = Date.now();
    status.connectionState = "connecting";
    status.reconnectAttempt = attempt;

    try {
      logger.info(`Opening Cloud Connector WebSocket (attempt ${attempt + 1})`);
      const outcome = await openWebSocket(
        config,
        runtime,
        signal,
        status,
        logger,
        controlPlaneFetch,
      );
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
  const accessToken = await generateAccessToken(
    getAccessTokenOptions(config, signal, controlPlaneFetch),
  );

  return new Promise<OpenOutcome>((resolve, reject) => {
    // The signal may have been aborted while the token was being fetched.
    // Adding an abort listener now would never fire (the transition already
    // happened), so bail out immediately to avoid a hung promise.
    if (signal.aborted) {
      reject(new Error("Cloud Connector shutting down before connect"));
      return;
    }

    const socket = new WebSocket(config.websocketUrl!, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    let opened = false;
    let openedAt = 0;
    let settled = false;
    let heartbeatId: ReturnType<typeof setInterval> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;

    const closeSocket = () => {
      try {
        socket.close();
      } catch {
        // already closing/closed
      }
    };
    const abort = () => closeSocket();

    function cleanup(): void {
      if (heartbeatId !== undefined) {
        clearInterval(heartbeatId);
        heartbeatId = undefined;
      }
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
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
        closeSocket();
        fail(
          new Error(
            `Cloud Connector WebSocket did not open within ${config.connectTimeoutMs}ms`,
          ),
        );
      }
    }, config.connectTimeoutMs);

    // Frame processing (request/response/heartbeat handling, logging).
    runtime.attachWebSocket(socket);

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
          }

          if (config.heartbeatTimeoutFactor > 0) {
            const lastInbound = status.lastInboundAt ?? openedAt;
            const silentFor = now - lastInbound;
            const limit = config.heartbeatIntervalMs *
              config.heartbeatTimeoutFactor;
            if (silentFor > limit) {
              logger.warn(
                `Cloud Connector WebSocket silent for ${silentFor}ms; reconnecting`,
              );
              // Peer is silent (half-open / dead): force reconnect.
              closeSocket();
            }
          }
        } catch {
          // Sending or any unexpected fault: force a reconnect.
          closeSocket();
        }
      }, config.heartbeatIntervalMs);
    });

    socket.addEventListener("error", (event) => {
      if (!opened) {
        fail(
          new Error("Unable to open Cloud Connector WebSocket", {
            cause: event,
          }),
        );
      }
      // If already open, wait for the "close" event to settle the promise.
    });

    socket.addEventListener("close", () => {
      const stableOpen = opened &&
        (Date.now() - openedAt) >= config.reconnectStableThresholdMs;
      settle({ stableOpen });
    });
  });
}

function getAccessTokenOptions(
  config: ConnectorConfig,
  signal: AbortSignal,
  fetcher: Fetcher,
): AccessTokenOptions {
  if (
    !config.cloudConnectorHost || !config.cloudConnectorClientId ||
    !config.cloudConnectorClientSecret
  ) {
    throw new Error("Cloud Connector authentication is not configured.");
  }

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
