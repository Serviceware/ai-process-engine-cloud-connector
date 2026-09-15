import { parse as parseYaml } from "@std/yaml";
import { defaultLogLevel, isLogLevel, type LogLevel } from "./logger.ts";
import { RuntimeError } from "./runtime-error.ts";

export type HeaderForwardingConfig = {
  add?: Record<string, string | string[]>;
  remove?: string[];
  set?: Record<string, string>;
};

export type RequestForwardingConfig = {
  headers?: HeaderForwardingConfig;
  /** Static path prefix applied before forwarding. */
  pathPrefix?: string;
  /** Forward caller credential headers instead of stripping them. */
  forwardIncomingCredentials?: boolean;
  /** Optional target authentication added by the connector. */
  auth?: AuthConfig;
};

export type ResponseForwardingConfig = {
  headers?: HeaderForwardingConfig;
};

export type AuthConfig =
  | {
    type: "basic";
    username: string;
    password: string;
  }
  | {
    type: "bearer";
    token: string;
  }
  | {
    type: "oauth2";
    /** OAuth 2.0 token endpoint used for the client-credentials grant. */
    issuer: string;
    clientId: string;
    clientSecret: string;
    scope?: string;
  };

export type ForwardingConfig = {
  /** Regular expression matched against the complete requested target URL. */
  target: string;
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
    purpose: string;
    heartbeatIntervalMs: number;
  };
  logging: {
    level: LogLevel;
  };
  forwarding: readonly ForwardingConfig[];
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
  maxResponseBodyBytes: number;
  maxConcurrentRequests: number;
  drainTimeoutMs: number;
};

/** Complete validated snapshot used by the runtime. */
export type ConnectorConfig = EnvironmentConfig & {
  websocketUrl: string;
  heartbeatIntervalMs: number;
  logLevel: LogLevel;
  forwarding: readonly ForwardingConfig[];
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
const defaultMaxResponseBodyBytes = 10 * 1024 * 1024;
const defaultMaxConcurrentRequests = 100;
const defaultDrainTimeoutSeconds = 30;
const serverHeartbeatIntervalMs = 30_000;

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
    maxResponseBodyBytes: readInteger(
      env.CLOUD_CONNECTOR_MAX_RESPONSE_BODY_BYTES,
      defaultMaxResponseBodyBytes,
      "CLOUD_CONNECTOR_MAX_RESPONSE_BODY_BYTES",
    ),
    maxConcurrentRequests: readInteger(
      env.CLOUD_CONNECTOR_MAX_CONCURRENT_REQUESTS,
      defaultMaxConcurrentRequests,
      "CLOUD_CONNECTOR_MAX_CONCURRENT_REQUESTS",
    ),
    drainTimeoutMs: readInteger(
      env.CLOUD_CONNECTOR_DRAIN_TIMEOUT_SECONDS,
      defaultDrainTimeoutSeconds,
      "CLOUD_CONNECTOR_DRAIN_TIMEOUT_SECONDS",
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
    environment.heartbeatTimeoutFactor,
  );

  return {
    ...environment,
    websocketUrl: deriveWebSocketUrl(
      environment.cloudConnectorHost,
      volume.connection.purpose,
    ),
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
    ["purpose", "heartbeatIntervalSeconds"],
    "connection",
  );
  const purpose = connection.purpose === undefined
    ? "main"
    : requireTrimmedNonEmptyString(connection.purpose, "connection.purpose");
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
      purpose,
      heartbeatIntervalMs: heartbeatIntervalSeconds * 1000,
    },
    logging: { level: logLevel },
    forwarding: validateAndNormalizeForwardingConfigs(config.forwarding),
  };
}

function validateAndNormalizeForwardingConfigs(
  value: unknown,
): readonly ForwardingConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("forwarding must be a non-empty array of rules");
  }
  return value.map((entry, index) =>
    validateAndNormalizeForwardingConfig(entry, `forwarding[${index}]`)
  );
}

function validateAndNormalizeForwardingConfig(
  value: unknown,
  path: string,
): ForwardingConfig {
  const config = requireRecord(value, path);
  rejectUnknown(
    config,
    [
      "target",
      "methods",
      "request",
      "response",
      "timeout",
    ],
    path,
  );
  requireNonEmptyString(config.target, `${path}.target`);
  const target = config.target.trim();
  try {
    new RegExp(target, "u");
  } catch (error) {
    throw new Error(`${path}.target is not a valid regular expression`, {
      cause: error,
    });
  }
  if (!target.startsWith("^") || !target.endsWith("$")) {
    throw new Error(
      `${path}.target must start with ^ and end with $ so it matches the complete URL`,
    );
  }
  if (hasUnsafeNestedQuantifier(target)) {
    throw new Error(
      `${path}.target contains nested or ambiguous repetition that may cause excessive backtracking`,
    );
  }

  if (config.methods !== undefined) {
    if (
      !Array.isArray(config.methods) ||
      new Set(config.methods).size !== config.methods.length ||
      config.methods.some((method) =>
        typeof method !== "string" || !supportedMethods.has(method)
      )
    ) {
      throw new Error(
        `${path}.methods must be an array of supported uppercase HTTP methods`,
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
      `${path}.timeout must be an integer between 1000 and 300000`,
    );
  }
  if (config.request !== undefined) {
    validateRequestConfig(config.request, `${path}.request`);
  }
  if (config.response !== undefined) {
    validateResponseConfig(config.response, `${path}.response`);
  }

  return {
    target,
    methods: config.methods as string[] | undefined,
    request: config.request as RequestForwardingConfig | undefined,
    response: config.response as ResponseForwardingConfig | undefined,
    timeout: config.timeout as number | undefined,
  };
}

function validateRequestConfig(value: unknown, path: string): void {
  const config = requireRecord(value, path);
  rejectUnknown(
    config,
    ["headers", "pathPrefix", "forwardIncomingCredentials", "auth"],
    path,
  );
  if (config.headers !== undefined) {
    validateHeaderConfig(config.headers, `${path}.headers`);
  }
  if (config.pathPrefix !== undefined) {
    requireString(config.pathPrefix, `${path}.pathPrefix`);
    if (
      !config.pathPrefix.startsWith("/") ||
      config.pathPrefix.startsWith("//") ||
      config.pathPrefix.includes("?") ||
      config.pathPrefix.includes("#") ||
      config.pathPrefix.includes("{{") ||
      config.pathPrefix.includes("}}")
    ) {
      throw new Error(
        `${path}.pathPrefix must be an absolute path without query or fragment`,
      );
    }
  }
  if (
    config.forwardIncomingCredentials !== undefined &&
    typeof config.forwardIncomingCredentials !== "boolean"
  ) {
    throw new Error(`${path}.forwardIncomingCredentials must be a boolean`);
  }
  if (config.auth !== undefined) {
    validateAuthConfig(config.auth, `${path}.auth`);
  }
}

function validateResponseConfig(value: unknown, path: string): void {
  const config = requireRecord(value, path);
  rejectUnknown(config, ["headers"], path);
  if (config.headers !== undefined) {
    validateHeaderConfig(config.headers, `${path}.headers`);
  }
}

function validateAuthConfig(value: unknown, path: string): void {
  const config = requireRecord(value, path);
  requireNonEmptyString(config.type, `${path}.type`);
  if (config.type === "basic") {
    rejectUnknown(config, ["type", "username", "password"], path);
    validateAuthValue(config.username, `${path}.username`);
    validateAuthValue(config.password, `${path}.password`);
    return;
  }
  if (config.type === "bearer") {
    rejectUnknown(config, ["type", "token"], path);
    validateAuthValue(config.token, `${path}.token`);
    return;
  }
  if (config.type === "oauth2") {
    rejectUnknown(
      config,
      ["type", "issuer", "clientId", "clientSecret", "scope"],
      path,
    );
    validateAuthValue(config.issuer, `${path}.issuer`);
    validateAuthValue(config.clientId, `${path}.clientId`);
    validateAuthValue(config.clientSecret, `${path}.clientSecret`);
    if (config.scope !== undefined) {
      validateAuthValue(config.scope, `${path}.scope`);
    }
    if (!(config.issuer as string).includes("{{")) {
      requireAbsoluteUrl(config.issuer, `${path}.issuer`, ["http:", "https:"]);
    }
    return;
  }
  throw new Error(`${path}.type must be one of: basic, bearer, oauth2`);
}

function validateAuthValue(value: unknown, path: string): void {
  requireNonEmptyString(value, path);
  validateTemplateExpressions(
    value,
    path,
    (expression) => /^env(?:\.|:)[A-Za-z_][A-Za-z0-9_]*$/.test(expression),
  );
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

function validateHeaderTemplate(template: string, path: string): void {
  validateTemplateExpressions(
    template,
    path,
    (expression) =>
      /^env(?:\.|:)[A-Za-z_][A-Za-z0-9_]*$/.test(expression) ||
      expression === "context.requestId" ||
      expression === "context.startedAt",
  );
}

export function deriveWebSocketUrl(
  cloudConnectorHost: string,
  purpose = "main",
): string {
  const url = new URL(cloudConnectorHost);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/configuration-store/api/v1/connector/${
    encodeURIComponent(purpose)
  }/connect`;
  url.search = "";
  url.hash = "";
  return url.toString();
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
  heartbeatTimeoutFactor: number,
): void {
  const minimum = Math.max(reconnectMaxDelayMs, heartbeatIntervalMs);
  if (livenessStaleMs <= minimum) {
    throw new Error(
      "CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS must be greater than both " +
        "CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS and the YAML " +
        "connection.heartbeatIntervalSeconds value",
    );
  }
  const peerSilenceWindowMs = heartbeatIntervalMs * heartbeatTimeoutFactor;
  if (
    heartbeatTimeoutFactor > 0 &&
    peerSilenceWindowMs <= serverHeartbeatIntervalMs
  ) {
    throw new Error(
      "The YAML connection.heartbeatIntervalSeconds multiplied by " +
        "CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR must be greater than the " +
        "30-second Serviceware Cloud heartbeat interval",
    );
  }
}

/** Conservative guard against common exponential-backtracking expressions. */
function hasUnsafeNestedQuantifier(pattern: string): boolean {
  type GroupState = { hasQuantifier: boolean; hasAlternation: boolean };
  const groups: GroupState[] = [{
    hasQuantifier: false,
    hasAlternation: false,
  }];
  let escaped = false;
  let inCharacterClass = false;
  let previousGroup: GroupState | undefined;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) {
      escaped = false;
      previousGroup = undefined;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      previousGroup = undefined;
      continue;
    }
    if (inCharacterClass) {
      if (char === "]") inCharacterClass = false;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      previousGroup = undefined;
      continue;
    }
    if (char === "(") {
      groups.push({ hasQuantifier: false, hasAlternation: false });
      previousGroup = undefined;
      continue;
    }
    if (char === ")" && groups.length > 1) {
      const closed = groups.pop()!;
      const parent = groups.at(-1)!;
      parent.hasQuantifier ||= closed.hasQuantifier;
      parent.hasAlternation ||= closed.hasAlternation;
      previousGroup = closed;
      continue;
    }
    if (char === "|") {
      groups.at(-1)!.hasAlternation = true;
      previousGroup = undefined;
      continue;
    }

    let isQuantifier = char === "*" || char === "+" || char === "?";
    let isUnbounded = char === "*" || char === "+";
    if (char === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end !== -1) {
        const range = pattern.slice(index + 1, end);
        if (/^\d+(?:,\d*)?$/.test(range)) {
          isQuantifier = true;
          isUnbounded = range.endsWith(",");
          index = end;
        }
      }
    }
    if (isQuantifier) {
      if (
        isUnbounded && previousGroup &&
        (previousGroup.hasQuantifier || previousGroup.hasAlternation)
      ) {
        return true;
      }
      groups.at(-1)!.hasQuantifier = true;
      previousGroup = undefined;
      continue;
    }
    if (char !== "^" && char !== "$") previousGroup = undefined;
  }
  return false;
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

function requireTrimmedNonEmptyString(value: unknown, path: string): string {
  requireNonEmptyString(value, path);
  return value.trim();
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
