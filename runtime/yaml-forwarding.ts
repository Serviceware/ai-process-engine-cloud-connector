import { parse as parseYaml } from "@std/yaml";
import type { ConnectorConfig } from "./config.ts";
import type { ProtocolExecutor } from "./connector.ts";
import type {
  CloudConnectorHttpRequest,
  CloudConnectorHttpResponse,
  CloudConnectorRequestFrame,
} from "./generated/models.ts";
import type { RuntimeLogger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import { createAllowlistedFetch, type Fetcher } from "./outbound-url-policy.ts";
import { RuntimeError } from "./runtime-error.ts";

const supportedMethods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export type YamlRequestTransformConfig = {
  headers?: HeaderTransformConfig;
  url?: {
    prefix?: string;
    suffix?: string;
    rewrite?: string;
    removePrefix?: string;
  };
  body?: { set?: string };
  reject?: {
    if?: string;
    code?: string;
    message?: string;
  };
};

export type YamlResponseTransformConfig = {
  headers?: HeaderTransformConfig;
  body?: { set?: string };
  statusCode?: { set?: number };
};

export type YamlForwardingConfig = {
  /** Base URL for every forwarded workload request. */
  target: string;
  /** Optional HTTP method restriction. Default: all supported methods. */
  methods?: string[];
  /** Optional request transformation applied before forwarding. */
  request?: YamlRequestTransformConfig;
  /** Optional response transformation applied after forwarding. */
  response?: YamlResponseTransformConfig;
  /** Upstream timeout in milliseconds. Default: 30000. */
  timeout?: number;
};

export type YamlTransformContext = {
  requestId: string;
  startedAt: string;
  request: CloudConnectorHttpRequest;
  env: Record<string, string>;
};

type HeaderTransformConfig = {
  add?: Record<string, string>;
  remove?: string[];
  set?: Record<string, string>;
};

export type YamlForwardingExecutorOptions = {
  config: ConnectorConfig;
  env?: Record<string, string>;
  logger?: RuntimeLogger;
  nextFetch?: Fetcher;
};

/**
 * The only workload execution path: one validated YAML configuration forwards
 * every inbound request to its configured target. No customer code is loaded
 * or evaluated and inbound URLs can never select a different target origin.
 */
export class YamlForwardingExecutor implements ProtocolExecutor {
  private constructor(
    private readonly forwarding: YamlForwardingConfig,
    private readonly targetBase: string,
    private readonly configPath: string,
    private readonly env: Record<string, string>,
    private readonly logger: RuntimeLogger,
    private readonly fetcher: Fetcher,
  ) {}

  static async create(
    options: YamlForwardingExecutorOptions,
  ): Promise<YamlForwardingExecutor> {
    const content = await readRequiredConfig(
      options.config.forwardingConfigFile,
    );
    const forwarding = parseYamlForwardingConfig(
      content,
      options.config.forwardingConfigFile,
    );
    const env = options.env ?? Deno.env.toObject();
    const targetBase = resolveTargetTemplate(
      forwarding.target,
      env,
      options.config.forwardingConfigFile,
    );
    // Resolve and validate the target during startup, not on the first request.
    parseTargetUrl(targetBase, "/", options.config.forwardingConfigFile);
    const logger = options.logger ?? createLogger(options.config.logLevel);
    logger.info(
      `Loaded YAML forwarding configuration from ${options.config.forwardingConfigFile}`,
    );

    return new YamlForwardingExecutor(
      forwarding,
      targetBase,
      options.config.forwardingConfigFile,
      env,
      logger,
      createAllowlistedFetch(
        options.config.outboundUrlAllowlist,
        options.nextFetch,
      ),
    );
  }

  async execute(
    frame: CloudConnectorRequestFrame,
  ): Promise<CloudConnectorHttpResponse> {
    const { request } = frame;
    if (
      this.forwarding.methods &&
      !this.forwarding.methods.includes(request.method)
    ) {
      throw new RuntimeError(
        "METHOD_NOT_ALLOWED",
        `Method ${request.method} is not enabled by ${this.configPath}`,
      );
    }

    const inboundUrl = new URL(request.url, "http://cloud-connector.invalid");
    let forwardedRequest: CloudConnectorHttpRequest = {
      ...request,
      url: inboundUrl.pathname + inboundUrl.search,
      headers: { ...request.headers },
    };
    const context: YamlTransformContext = {
      requestId: frame.requestId,
      startedAt: new Date().toISOString(),
      request: forwardedRequest,
      env: this.env,
    };

    if (this.forwarding.request) {
      forwardedRequest = applyYamlRequestTransform(
        this.forwarding.request,
        forwardedRequest,
        context,
      );
    }

    if (
      !forwardedRequest.url.startsWith("/") ||
      forwardedRequest.url.startsWith("//")
    ) {
      throw new RuntimeError(
        "CONFIG_ERROR",
        `Forwarded request URL must remain an absolute path in ${this.configPath}`,
      );
    }

    const targetUrl = parseTargetUrl(
      this.targetBase,
      forwardedRequest.url,
      this.configPath,
    );
    const headers = buildHeaders(forwardedRequest.headers);
    removeHopByHopHeaders(headers);

    this.logger.info(
      `Forwarding ${forwardedRequest.method} ${forwardedRequest.url} to ${targetUrl.origin}`,
    );

    const timeout = this.forwarding.timeout ?? 30_000;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await this.fetcher(targetUrl, {
        method: forwardedRequest.method,
        headers,
        body: forwardedRequest.method === "GET" ||
            forwardedRequest.method === "HEAD"
          ? undefined
          : forwardedRequest.body ?? undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (error instanceof RuntimeError) {
        throw error;
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new RuntimeError(
          "TIMEOUT",
          `Forwarding request timed out after ${timeout}ms`,
          { cause: error },
        );
      }
      throw new RuntimeError(
        "TARGET_REQUEST_ERROR",
        `Forwarding request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    let response: CloudConnectorHttpResponse = {
      statusCode: upstreamResponse.status,
      headers: headersToRecord(upstreamResponse.headers),
      body: (await upstreamResponse.text()) || null,
    };
    if (this.forwarding.response) {
      response = applyYamlResponseTransform(
        this.forwarding.response,
        response,
        { ...context, request: forwardedRequest },
      );
    }
    return response;
  }
}

export function createYamlForwardingExecutor(
  options: YamlForwardingExecutorOptions,
): Promise<YamlForwardingExecutor> {
  return YamlForwardingExecutor.create(options);
}

export function parseYamlForwardingConfig(
  content: string,
  path: string,
): YamlForwardingConfig {
  let value: unknown;
  try {
    value = parseYaml(content);
  } catch (error) {
    throw new RuntimeError(
      "YAML_PARSE_ERROR",
      `Failed to parse YAML forwarding config at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  try {
    validateForwardingConfig(value);
  } catch (error) {
    throw new RuntimeError(
      "CONFIG_ERROR",
      `Invalid YAML forwarding config at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  return value;
}

export function applyYamlRequestTransform(
  config: YamlRequestTransformConfig,
  request: CloudConnectorHttpRequest,
  context: YamlTransformContext,
): CloudConnectorHttpRequest {
  const result = { ...request, headers: { ...request.headers } };
  const evalContext: YamlTransformContext = { ...context, request };

  if (
    config.reject?.if &&
    evaluateCondition(config.reject.if, evalContext)
  ) {
    throw new RuntimeError(
      config.reject.code ?? "REQUEST_REJECTED",
      interpolate(
        config.reject.message ?? "Request rejected by YAML configuration",
        evalContext,
      ),
    );
  }
  if (config.headers) {
    result.headers = applyHeaderTransforms(
      result.headers ?? {},
      config.headers,
      evalContext,
    );
  }
  if (config.url) {
    result.url = applyUrlTransforms(result.url, config.url, evalContext);
  }
  if (config.body?.set !== undefined) {
    result.body = interpolate(config.body.set, evalContext);
  }
  return result;
}

export function applyYamlResponseTransform(
  config: YamlResponseTransformConfig,
  response: CloudConnectorHttpResponse,
  context: YamlTransformContext,
): CloudConnectorHttpResponse {
  const result = { ...response, headers: { ...response.headers } };
  if (config.headers) {
    result.headers = applyHeaderTransforms(
      result.headers ?? {},
      config.headers,
      context,
    );
  }
  if (config.body?.set !== undefined) {
    result.body = interpolate(config.body.set, context);
  }
  if (config.statusCode?.set !== undefined) {
    result.statusCode = config.statusCode.set;
  }
  return result;
}

export function interpolate(
  template: string,
  context: YamlTransformContext,
): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expression: string) => {
    return resolveExpression(expression.trim(), context);
  });
}

function applyHeaderTransforms(
  headers: NonNullable<CloudConnectorHttpRequest["headers"]>,
  config: HeaderTransformConfig,
  context: YamlTransformContext,
): NonNullable<CloudConnectorHttpRequest["headers"]> {
  const result = { ...headers };
  for (const name of config.remove ?? []) {
    const normalizedName = name.toLowerCase();
    for (const key of Object.keys(result)) {
      if (key.toLowerCase() === normalizedName) delete result[key];
    }
  }
  for (const [name, value] of Object.entries(config.set ?? {})) {
    result[name] = [interpolate(value, context)];
  }
  for (const [name, value] of Object.entries(config.add ?? {})) {
    result[name] = [...(result[name] ?? []), interpolate(value, context)];
  }
  return result;
}

function applyUrlTransforms(
  url: string,
  config: NonNullable<YamlRequestTransformConfig["url"]>,
  context: YamlTransformContext,
): string {
  let result = url;
  if (config.removePrefix) {
    const prefix = interpolate(config.removePrefix, context);
    if (result.startsWith(prefix)) result = result.slice(prefix.length);
  }
  if (config.rewrite) {
    result = interpolate(config.rewrite, context);
  } else {
    if (config.prefix) result = interpolate(config.prefix, context) + result;
    if (config.suffix) result += interpolate(config.suffix, context);
  }
  return result;
}

function resolveExpression(
  expression: string,
  context: YamlTransformContext,
): string {
  const parts = expression.split(".");
  if (parts[0] === "env" && parts.length === 2) {
    return context.env[parts[1]] ?? "";
  }
  if (parts[0] === "context") {
    if (parts[1] === "requestId") return context.requestId;
    if (parts[1] === "startedAt") return context.startedAt;
  }
  if (parts[0] === "request") {
    if (parts[1] === "url") return context.request.url;
    if (parts[1] === "method") return context.request.method;
    if (parts[1] === "body") return context.request.body ?? "";
  }
  return "";
}

function evaluateCondition(
  condition: string,
  context: YamlTransformContext,
): boolean {
  for (
    const [pattern, predicate] of [
      [
        /^(.+?)\s+contains\s+"([^"]+)"$/,
        (a: string, b: string) => a.includes(b),
      ],
      [/^(.+?)\s*==\s*"([^"]*)"$/, (a: string, b: string) => a === b],
      [/^(.+?)\s*!=\s*"([^"]*)"$/, (a: string, b: string) => a !== b],
      [
        /^(.+?)\s+startsWith\s+"([^"]+)"$/,
        (a: string, b: string) => a.startsWith(b),
      ],
      [
        /^(.+?)\s+endsWith\s+"([^"]+)"$/,
        (a: string, b: string) => a.endsWith(b),
      ],
    ] as const
  ) {
    const match = condition.match(pattern);
    if (match) {
      return predicate(resolveExpression(match[1].trim(), context), match[2]);
    }
  }
  return false;
}

async function readRequiredConfig(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    throw new RuntimeError(
      "CONFIG_ERROR",
      `Cannot read required YAML forwarding config at ${path}`,
      { cause: error },
    );
  }
}

function parseTargetUrl(
  target: string,
  requestPath: string,
  configPath: string,
): URL {
  let base: URL;
  try {
    base = new URL(target);
  } catch (error) {
    throw new RuntimeError(
      "CONFIG_ERROR",
      `Forwarding target in ${configPath} is not a valid absolute URL`,
      { cause: error },
    );
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new RuntimeError(
      "CONFIG_ERROR",
      `Forwarding target in ${configPath} must use HTTP or HTTPS`,
    );
  }
  return new URL(requestPath, base);
}

function buildHeaders(
  values: CloudConnectorHttpRequest["headers"],
): Headers {
  const headers = new Headers();
  for (const [name, entries] of Object.entries(values ?? {})) {
    for (const value of entries) headers.append(name, value);
  }
  return headers;
}

function headersToRecord(headers: Headers): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  headers.forEach((value, name) => (result[name] ??= []).push(value));
  return result;
}

function removeHopByHopHeaders(headers: Headers): void {
  for (
    const name of [
      "host",
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]
  ) {
    headers.delete(name);
  }
}

function validateForwardingConfig(
  value: unknown,
): asserts value is YamlForwardingConfig {
  const config = requireRecord(value, "configuration");
  rejectUnknown(
    config,
    ["target", "methods", "request", "response", "timeout"],
    "configuration",
  );
  requireNonEmptyString(config.target, "target");
  validateTargetTemplate(config.target);
  if (config.methods !== undefined) {
    if (
      !Array.isArray(config.methods) || config.methods.length === 0 ||
      config.methods.some((method) =>
        typeof method !== "string" || !supportedMethods.has(method)
      )
    ) {
      throw new Error(
        "methods must be a non-empty array of supported uppercase HTTP methods",
      );
    }
  }
  if (
    config.timeout !== undefined &&
    (typeof config.timeout !== "number" ||
      !Number.isInteger(config.timeout) || config.timeout < 1_000 ||
      config.timeout > 300_000)
  ) {
    throw new Error("timeout must be an integer between 1000 and 300000");
  }
  if (config.request !== undefined) validateRequestTransform(config.request);
  if (config.response !== undefined) validateResponseTransform(config.response);
}

function validateRequestTransform(value: unknown): void {
  const config = requireRecord(value, "request");
  rejectUnknown(config, ["headers", "url", "body", "reject"], "request");
  if (config.headers !== undefined) {
    validateHeaderTransform(config.headers, "request.headers");
  }
  if (config.url !== undefined) {
    const url = requireRecord(config.url, "request.url");
    rejectUnknown(
      url,
      ["prefix", "suffix", "rewrite", "removePrefix"],
      "request.url",
    );
    for (const [name, entry] of Object.entries(url)) {
      requireString(entry, `request.url.${name}`);
    }
  }
  if (config.body !== undefined) {
    validateStringPropertyObject(config.body, "request.body", ["set"]);
  }
  if (config.reject !== undefined) {
    const reject = requireRecord(config.reject, "request.reject");
    rejectUnknown(reject, ["if", "code", "message"], "request.reject");
    for (const [name, entry] of Object.entries(reject)) {
      requireString(entry, `request.reject.${name}`);
    }
  }
}

function validateResponseTransform(value: unknown): void {
  const config = requireRecord(value, "response");
  rejectUnknown(config, ["headers", "body", "statusCode"], "response");
  if (config.headers !== undefined) {
    validateHeaderTransform(config.headers, "response.headers");
  }
  if (config.body !== undefined) {
    validateStringPropertyObject(config.body, "response.body", ["set"]);
  }
  if (config.statusCode !== undefined) {
    const status = requireRecord(config.statusCode, "response.statusCode");
    rejectUnknown(status, ["set"], "response.statusCode");
    if (
      status.set !== undefined &&
      (typeof status.set !== "number" || !Number.isInteger(status.set) ||
        status.set < 100 || status.set > 599)
    ) {
      throw new Error(
        "response.statusCode.set must be an integer between 100 and 599",
      );
    }
  }
}

function validateHeaderTransform(value: unknown, path: string): void {
  const config = requireRecord(value, path);
  rejectUnknown(config, ["add", "remove", "set"], path);
  for (const name of ["add", "set"] as const) {
    if (config[name] === undefined) continue;
    const entries = requireRecord(config[name], `${path}.${name}`);
    for (const [key, entry] of Object.entries(entries)) {
      requireString(entry, `${path}.${name}.${key}`);
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

function validateStringPropertyObject(
  value: unknown,
  path: string,
  properties: string[],
): void {
  const config = requireRecord(value, path);
  rejectUnknown(config, properties, path);
  for (const [name, entry] of Object.entries(config)) {
    requireString(entry, `${path}.${name}`);
  }
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

function validateTargetTemplate(target: string): void {
  const expressions = target.matchAll(/\{\{\s*([^}]+)\s*\}\}/g);
  for (const match of expressions) {
    if (!/^env\.[A-Za-z_][A-Za-z0-9_]*$/.test(match[1].trim())) {
      throw new Error(
        "target interpolation supports only {{ env.NAME }} values",
      );
    }
  }
  if (!target.includes("{{")) {
    parseTargetUrl(target, "/", "configuration");
  }
}

function resolveTargetTemplate(
  target: string,
  env: Record<string, string>,
  configPath: string,
): string {
  const resolved = target.replace(
    /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (_, name: string) => env[name] ?? "",
  );
  if (!resolved.trim()) {
    throw new RuntimeError(
      "CONFIG_ERROR",
      `Forwarding target in ${configPath} is empty after environment interpolation`,
    );
  }
  return resolved;
}
