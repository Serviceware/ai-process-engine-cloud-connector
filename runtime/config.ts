import { defaultLogLevel, isLogLevel, type LogLevel } from "./logger.ts";

export type ConnectorConfig = {
  host: string;
  port: number;
  websocketUrl?: string;
  cloudConnectorHost?: string;
  cloudConnectorClientId?: string;
  cloudConnectorClientSecret?: string;
  functionsDir: string;
  heartbeatIntervalMs: number;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  /** Max time to wait for the WebSocket "open" event before retrying. */
  connectTimeoutMs: number;
  /** Min continuous open duration before the backoff counter resets (anti-flap). */
  reconnectStableThresholdMs: number;
  /**
   * Number of heartbeat intervals without ANY inbound frame after which the
   * peer is treated as dead and the socket is force-closed. 0 disables the
   * watchdog.
   */
  heartbeatTimeoutFactor: number;
  /** Timeout applied to the access-token fetches. */
  tokenFetchTimeoutMs: number;
  /** Fraction of the backoff delay that is randomized (equal jitter), 0..1. */
  reconnectJitterRatio: number;
  /** Staleness window for /health liveness; must exceed reconnectMaxDelayMs. */
  livenessStaleMs: number;
  /** Runtime log verbosity. */
  logLevel: LogLevel;
  /** Regular expressions that allow workload HTTP requests by absolute URL. */
  outboundUrlAllowlist: readonly string[];
};

const defaultPort = 8080;
const defaultFunctionsDir = "functions";
const defaultHeartbeatSeconds = 30;
const defaultReconnectInitialSeconds = 1;
const defaultReconnectMaxSeconds = 30;
const defaultConnectTimeoutSeconds = 10;
const defaultReconnectStableSeconds = 5;
const defaultHeartbeatTimeoutFactor = 3;
const defaultTokenFetchTimeoutSeconds = 10;
const defaultReconnectJitterRatio = 0.5;
const defaultLivenessStaleSeconds = 120;

export function loadConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): ConnectorConfig {
  const websocketUrl = readOptionalUrl(
    env.CLOUD_CONNECTOR_WS_URL,
    "CLOUD_CONNECTOR_WS_URL",
    ["ws:", "wss:"],
  );
  const cloudConnectorHost = readOptionalUrl(
    env.CLOUD_CONNECTOR_HOST,
    "CLOUD_CONNECTOR_HOST",
    ["http:", "https:"],
  );
  const cloudConnectorClientId = readOptionalText(
    env.CLOUD_CONNECTOR_CLIENT_ID,
  );
  const cloudConnectorClientSecret = readOptionalText(
    env.CLOUD_CONNECTOR_CLIENT_SECRET,
  );

  validateCloudConnectorAuth(
    websocketUrl,
    cloudConnectorHost,
    cloudConnectorClientId,
    cloudConnectorClientSecret,
  );

  const reconnectMaxDelayMs = readInteger(
    env.CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS,
    defaultReconnectMaxSeconds,
    "CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS",
  ) * 1000;
  const heartbeatIntervalMs = readInteger(
    env.CLOUD_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS,
    defaultHeartbeatSeconds,
    "CLOUD_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS",
  ) * 1000;
  const livenessStaleMs = readInteger(
    env.CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS,
    defaultLivenessStaleSeconds,
    "CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS",
  ) * 1000;

  validateLivenessWindow(
    livenessStaleMs,
    reconnectMaxDelayMs,
    heartbeatIntervalMs,
  );

  return {
    host: env.CONNECTOR_HOST ?? "0.0.0.0",
    port: readInteger(env.CONNECTOR_PORT, defaultPort, "CONNECTOR_PORT"),
    websocketUrl,
    cloudConnectorHost,
    cloudConnectorClientId,
    cloudConnectorClientSecret,
    functionsDir: readOptionalPath(env.CLOUD_CONNECTOR_FUNCTIONS_DIR) ??
      defaultFunctionsDir,
    heartbeatIntervalMs,
    reconnectInitialDelayMs: readInteger(
      env.CLOUD_CONNECTOR_RECONNECT_INITIAL_SECONDS,
      defaultReconnectInitialSeconds,
      "CLOUD_CONNECTOR_RECONNECT_INITIAL_SECONDS",
    ) * 1000,
    reconnectMaxDelayMs,
    connectTimeoutMs: readInteger(
      env.CLOUD_CONNECTOR_CONNECT_TIMEOUT_SECONDS,
      defaultConnectTimeoutSeconds,
      "CLOUD_CONNECTOR_CONNECT_TIMEOUT_SECONDS",
    ) * 1000,
    reconnectStableThresholdMs: readInteger(
      env.CLOUD_CONNECTOR_RECONNECT_STABLE_SECONDS,
      defaultReconnectStableSeconds,
      "CLOUD_CONNECTOR_RECONNECT_STABLE_SECONDS",
    ) * 1000,
    heartbeatTimeoutFactor: readNonNegativeInteger(
      env.CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR,
      defaultHeartbeatTimeoutFactor,
      "CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR",
    ),
    tokenFetchTimeoutMs: readInteger(
      env.CLOUD_CONNECTOR_TOKEN_TIMEOUT_SECONDS,
      defaultTokenFetchTimeoutSeconds,
      "CLOUD_CONNECTOR_TOKEN_TIMEOUT_SECONDS",
    ) * 1000,
    reconnectJitterRatio: readRatio(
      env.CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO,
      defaultReconnectJitterRatio,
      "CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO",
    ),
    livenessStaleMs,
    logLevel: readLogLevel(env.CLOUD_CONNECTOR_LOG_LEVEL),
    outboundUrlAllowlist: readRegexList(
      env.OUTBOUND_URL_ALLOWLIST,
      "OUTBOUND_URL_ALLOWLIST",
    ),
  };
}

function readRegexList(
  value: string | undefined,
  name: string,
): readonly string[] {
  const trimmed = value?.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${name} must be a JSON array of regular expressions`, {
      cause: error,
    });
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((pattern) => typeof pattern !== "string" || !pattern.trim())
  ) {
    throw new Error(`${name} must be a JSON array of non-empty strings`);
  }

  return parsed.map((pattern, index) => {
    const normalized = (pattern as string).trim();
    try {
      new RegExp(normalized, "u");
    } catch (error) {
      throw new Error(
        `${name}[${index}] is not a valid regular expression: ${normalized}`,
        { cause: error },
      );
    }
    return normalized;
  });
}

function readLogLevel(value: string | undefined): LogLevel {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return defaultLogLevel;
  }

  if (!isLogLevel(trimmed)) {
    throw new Error(
      "CLOUD_CONNECTOR_LOG_LEVEL must be one of: error, warn, info, debug",
    );
  }

  return trimmed;
}

function validateLivenessWindow(
  livenessStaleMs: number,
  reconnectMaxDelayMs: number,
  heartbeatIntervalMs: number,
): void {
  // The supervision loop refreshes its liveness tick at most once per backoff
  // (while reconnecting) and once per heartbeat (while connected). The window
  // must exceed both, or a Cloud Connector that is healthy-but-idle or
  // legitimately backing off would falsely fail /health and be killed
  // mid-recovery.
  const minimum = Math.max(reconnectMaxDelayMs, heartbeatIntervalMs);
  if (livenessStaleMs <= minimum) {
    throw new Error(
      "CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS must be greater than both " +
        "CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS and " +
        "CLOUD_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS so a healthy or " +
        "recovering Cloud Connector is not killed mid-recovery",
    );
  }
}

function validateCloudConnectorAuth(
  websocketUrl: string | undefined,
  cloudConnectorHost: string | undefined,
  cloudConnectorClientId: string | undefined,
  cloudConnectorClientSecret: string | undefined,
): void {
  const hasAuthConfig = cloudConnectorHost !== undefined ||
    cloudConnectorClientId !== undefined ||
    cloudConnectorClientSecret !== undefined;
  if (websocketUrl === undefined && !hasAuthConfig) {
    return;
  }

  const missingVariables = [
    ["CLOUD_CONNECTOR_HOST", cloudConnectorHost],
    ["CLOUD_CONNECTOR_CLIENT_ID", cloudConnectorClientId],
    ["CLOUD_CONNECTOR_CLIENT_SECRET", cloudConnectorClientSecret],
  ].flatMap(([name, value]) => value === undefined ? [name] : []);

  if (missingVariables.length > 0) {
    throw new Error(
      `Cloud Connector authentication requires ${missingVariables.join(", ")}`,
    );
  }
}

function readOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalUrl(
  value: string | undefined,
  name: string,
  allowedProtocols: string[],
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new Error(`${name} must be a valid absolute URL`, { cause: error });
  }

  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(
      `${name} must use one of these protocols: ${allowedProtocols.join(", ")}`,
    );
  }

  return url.toString();
}

function readInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readNonNegativeInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

function readRatio(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseFloat(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }

  return parsed;
}
