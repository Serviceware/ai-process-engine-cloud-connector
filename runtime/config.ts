import { parse as parseYaml } from "@std/yaml";
import { defaultLogLevel, isLogLevel, type LogLevel } from "./logger.ts";
import { RuntimeError } from "./runtime-error.ts";

export type HeaderForwardingConfig = {
  add?: Record<string, string>;
  remove?: string[];
  set?: Record<string, string>;
};

export type RequestForwardingConfig = {
  headers?: HeaderForwardingConfig;
  /** Static path prefix applied before forwarding. */
  pathPrefix?: string;
};

export type ResponseForwardingConfig = {
  headers?: HeaderForwardingConfig;
};

export type ForwardingConfig = {
  /** Base URL for every forwarded workload request. */
  target: string;
  /** URLs permitted for the initial request and every redirect. */
  outboundUrlAllowlist: readonly string[];
  /** Optional HTTP method restriction. Default: all supported methods. */
  methods?: string[];
  /** Optional request forwarding settings. */
  request?: RequestForwardingConfig;
  /** Optional response forwarding settings. */
  response?: ResponseForwardingConfig;
  /** Upstream timeout in milliseconds. Default: 30000. */
  timeout?: number;
};

/** Settings read from the one hot-reloadable file mounted into the container. */
export type VolumeConfig = {
  connection: {
    websocketUrl: string;
    heartbeatIntervalMs: number;
  };
  logging: {
    level: LogLevel;
  };
  forwarding: ForwardingConfig;
};

/**
 * Process-level settings. Credentials and resilience tuning deliberately stay
 * outside the mounted file because changing them requires a fresh process (or
 * secret projection) and should not silently alter forwarding behaviour.
 */
export type EnvironmentConfig = {
  cloudConnectorHost: string;
  cloudConnectorClientId: string;
  cloudConnectorClientSecret: string;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  connectTimeoutMs: number;
  reconnectStableThresholdMs: number;
  heartbeatTimeoutFactor: number;
  tokenFetchTimeoutMs: number;
  reconnectJitterRatio: number;
  livenessStaleMs: number;
};

/** Complete validated snapshot used by the runtime. */
export type ConnectorConfig = EnvironmentConfig & {
  websocketUrl: string;
  heartbeatIntervalMs: number;
  logLevel: LogLevel;
  forwarding: ForwardingConfig;
};

export const defaultConfigPath = "/config/cloud-connector.yml";
export const connectorListenHost = "0.0.0.0";
export const connectorListenPort = 8080;

const defaultHeartbeatSeconds = 30;
const defaultReconnectInitialSeconds = 1;
const defaultReconnectMaxSeconds = 30;
const defaultConnectTimeoutSeconds = 10;
const defaultReconnectStableSeconds = 5;
const defaultHeartbeatTimeoutFactor = 3;
const defaultTokenFetchTimeoutSeconds = 10;
const defaultReconnectJitterRatio = 0.5;
const defaultLivenessStaleSeconds = 120;

const supportedMethods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export function loadEnvironmentConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): EnvironmentConfig {
  return {
    cloudConnectorHost: readRequiredUrl(
      env.CLOUD_CONNECTOR_HOST,
      "CLOUD_CONNECTOR_HOST",
      ["http:", "https:"],
    ),
    cloudConnectorClientId: readRequiredText(
      env.CLOUD_CONNECTOR_CLIENT_ID,
      "CLOUD_CONNECTOR_CLIENT_ID",
    ),
    cloudConnectorClientSecret: readRequiredText(
      env.CLOUD_CONNECTOR_CLIENT_SECRET,
      "CLOUD_CONNECTOR_CLIENT_SECRET",
    ),
    reconnectInitialDelayMs: readInteger(
      env.CLOUD_CONNECTOR_RECONNECT_INITIAL_SECONDS,
      defaultReconnectInitialSeconds,
      "CLOUD_CONNECTOR_RECONNECT_INITIAL_SECONDS",
    ) * 1000,
    reconnectMaxDelayMs: readInteger(
      env.CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS,
      defaultReconnectMaxSeconds,
      "CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS",
    ) * 1000,
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
    livenessStaleMs: readInteger(
      env.CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS,
      defaultLivenessStaleSeconds,
      "CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS",
    ) * 1000,
  };
}

export async function loadVolumeConfig(path: string): Promise<VolumeConfig> {
  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch (error) {
    throw new RuntimeError(
      "CONFIG_ERROR",
      `Cannot read required Cloud Connector YAML config at ${path}`,
      { cause: error },
    );
  }
  return parseVolumeConfig(content, path);
}

export function parseVolumeConfig(
  content: string,
  path = "cloud-connector.yml",
): VolumeConfig {
  let value: unknown;
  try {
    value = parseYaml(content);
  } catch (error) {
    throw new RuntimeError(
      "YAML_PARSE_ERROR",
      `Failed to parse Cloud Connector YAML config at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  try {
    return validateAndNormalizeVolumeConfig(value);
  } catch (error) {
    throw new RuntimeError(
      "CONFIG_ERROR",
      `Invalid Cloud Connector YAML config at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export function combineConfig(
  environment: EnvironmentConfig,
  volume: VolumeConfig,
): ConnectorConfig {
  validateLivenessWindow(
    environment.livenessStaleMs,
    environment.reconnectMaxDelayMs,
    volume.connection.heartbeatIntervalMs,
  );

  return {
    ...environment,
    websocketUrl: volume.connection.websocketUrl,
    heartbeatIntervalMs: volume.connection.heartbeatIntervalMs,
    logLevel: volume.logging.level,
    forwarding: volume.forwarding,
  };
}

function validateAndNormalizeVolumeConfig(value: unknown): VolumeConfig {
  const config = requireRecord(value, "configuration");
  rejectUnknown(
    config,
    ["connection", "logging", "forwarding"],
    "configuration",
  );

  const connection = requireRecord(config.connection, "connection");
  rejectUnknown(
    connection,
    ["websocketUrl", "heartbeatIntervalSeconds"],
    "connection",
  );
  const websocketUrl = requireAbsoluteUrl(
    connection.websocketUrl,
    "connection.websocketUrl",
    ["ws:", "wss:"],
  );
  const heartbeatIntervalSeconds = connection.heartbeatIntervalSeconds ===
      undefined
    ? defaultHeartbeatSeconds
    : requirePositiveInteger(
      connection.heartbeatIntervalSeconds,
      "connection.heartbeatIntervalSeconds",
    );

  let logLevel = defaultLogLevel;
  if (config.logging !== undefined) {
    const logging = requireRecord(config.logging, "logging");
    rejectUnknown(logging, ["level"], "logging");
    if (logging.level !== undefined) {
      if (
        typeof logging.level !== "string" || !isLogLevel(logging.level)
      ) {
        throw new Error(
          "logging.level must be one of: error, warn, info, debug",
        );
      }
      logLevel = logging.level;
    }
  }

  return {
    connection: {
      websocketUrl,
      heartbeatIntervalMs: heartbeatIntervalSeconds * 1000,
    },
    logging: { level: logLevel },
    forwarding: validateAndNormalizeForwardingConfig(config.forwarding),
  };
}

function validateAndNormalizeForwardingConfig(
  value: unknown,
): ForwardingConfig {
  const config = requireRecord(value, "forwarding");
  rejectUnknown(
    config,
    [
      "target",
      "outboundUrlAllowlist",
      "methods",
      "request",
      "response",
      "timeout",
    ],
    "forwarding",
  );
  requireNonEmptyString(config.target, "forwarding.target");
  validateTargetTemplate(config.target);

  let outboundUrlAllowlist: string[] = [];
  if (config.outboundUrlAllowlist !== undefined) {
    if (
      !Array.isArray(config.outboundUrlAllowlist) ||
      config.outboundUrlAllowlist.some((pattern) =>
        typeof pattern !== "string" || !pattern.trim()
      )
    ) {
      throw new Error(
        "forwarding.outboundUrlAllowlist must be an array of non-empty strings",
      );
    }
    outboundUrlAllowlist = config.outboundUrlAllowlist.map((pattern, index) => {
      const normalized = pattern.trim();
      try {
        new RegExp(normalized, "u");
      } catch (error) {
        throw new Error(
          `forwarding.outboundUrlAllowlist[${index}] is not a valid regular expression`,
          { cause: error },
        );
      }
      return normalized;
    });
  }

  if (config.methods !== undefined) {
    if (
      !Array.isArray(config.methods) || config.methods.length === 0 ||
      new Set(config.methods).size !== config.methods.length ||
      config.methods.some((method) =>
        typeof method !== "string" || !supportedMethods.has(method)
      )
    ) {
      throw new Error(
        "forwarding.methods must be a non-empty array of supported uppercase HTTP methods",
      );
    }
  }
  if (
    config.timeout !== undefined &&
    (typeof config.timeout !== "number" ||
      !Number.isInteger(config.timeout) || config.timeout < 1_000 ||
      config.timeout > 300_000)
  ) {
    throw new Error(
      "forwarding.timeout must be an integer between 1000 and 300000",
    );
  }
  if (config.request !== undefined) validateRequestConfig(config.request);
  if (config.response !== undefined) validateResponseConfig(config.response);

  return {
    target: config.target,
    outboundUrlAllowlist,
    methods: config.methods as string[] | undefined,
    request: config.request as RequestForwardingConfig | undefined,
    response: config.response as ResponseForwardingConfig | undefined,
    timeout: config.timeout as number | undefined,
  };
}

function validateRequestConfig(value: unknown): void {
  const config = requireRecord(value, "forwarding.request");
  rejectUnknown(
    config,
    ["headers", "pathPrefix"],
    "forwarding.request",
  );
  if (config.headers !== undefined) {
    validateHeaderConfig(config.headers, "forwarding.request.headers");
  }
  if (config.pathPrefix !== undefined) {
    requireString(config.pathPrefix, "forwarding.request.pathPrefix");
    if (
      !config.pathPrefix.startsWith("/") ||
      config.pathPrefix.startsWith("//") ||
      config.pathPrefix.includes("?") ||
      config.pathPrefix.includes("#") ||
      config.pathPrefix.includes("{{") ||
      config.pathPrefix.includes("}}")
    ) {
      throw new Error(
        "forwarding.request.pathPrefix must be an absolute path without query or fragment",
      );
    }
  }
}

function validateResponseConfig(value: unknown): void {
  const config = requireRecord(value, "forwarding.response");
  rejectUnknown(config, ["headers"], "forwarding.response");
  if (config.headers !== undefined) {
    validateHeaderConfig(config.headers, "forwarding.response.headers");
  }
}

function validateHeaderConfig(value: unknown, path: string): void {
  const config = requireRecord(value, path);
  rejectUnknown(config, ["add", "remove", "set"], path);
  for (const name of ["add", "set"] as const) {
    if (config[name] === undefined) continue;
    const entries = requireRecord(config[name], `${path}.${name}`);
    for (const [key, entry] of Object.entries(entries)) {
      requireString(entry, `${path}.${name}.${key}`);
      validateHeaderTemplate(entry, `${path}.${name}.${key}`);
    }
  }
  if (
    config.remove !== undefined &&
    (!Array.isArray(config.remove) ||
      config.remove.some((entry) => typeof entry !== "string"))
  ) {
    throw new Error(`${path}.remove must be an array of strings`);
  }
}

function validateTargetTemplate(target: string): void {
  validateTemplateExpressions(
    target,
    "forwarding.target",
    (expression) => /^env\.[A-Za-z_][A-Za-z0-9_]*$/.test(expression),
  );
  if (!target.includes("{{")) {
    requireAbsoluteUrl(target, "forwarding.target", ["http:", "https:"]);
  }
}

function validateHeaderTemplate(template: string, path: string): void {
  validateTemplateExpressions(
    template,
    path,
    (expression) =>
      /^env\.[A-Za-z_][A-Za-z0-9_]*$/.test(expression) ||
      expression === "context.requestId" ||
      expression === "context.startedAt",
  );
}

function validateTemplateExpressions(
  template: string,
  path: string,
  allows: (expression: string) => boolean,
): void {
  const pattern = /\{\{\s*([^}]+)\s*\}\}/g;
  for (const match of template.matchAll(pattern)) {
    if (!allows(match[1].trim())) {
      throw new Error(`${path} contains an unsupported interpolation value`);
    }
  }
  const remaining = template.replace(pattern, "");
  if (remaining.includes("{{") || remaining.includes("}}")) {
    throw new Error(`${path} contains malformed interpolation syntax`);
  }
}

function validateLivenessWindow(
  livenessStaleMs: number,
  reconnectMaxDelayMs: number,
  heartbeatIntervalMs: number,
): void {
  const minimum = Math.max(reconnectMaxDelayMs, heartbeatIntervalMs);
  if (livenessStaleMs <= minimum) {
    throw new Error(
      "CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS must be greater than both " +
        "CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS and the YAML " +
        "connection.heartbeatIntervalSeconds value",
    );
  }
}

function requireAbsoluteUrl(
  value: unknown,
  name: string,
  allowedProtocols: string[],
): string {
  requireNonEmptyString(value, name);
  let url: URL;
  try {
    url = new URL(value.trim());
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

function readRequiredUrl(
  value: string | undefined,
  name: string,
  allowedProtocols: string[],
): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return requireAbsoluteUrl(value, name, allowedProtocols);
}

function readRequiredText(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${path}.${unknown} is not supported`);
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
}

function requireNonEmptyString(
  value: unknown,
  path: string,
): asserts value is string {
  requireString(value, path);
  if (!value.trim()) throw new Error(`${path} must not be empty`);
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function readInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
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
  if (value === undefined || value.trim() === "") return fallback;
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
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseFloat(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  return parsed;
}
