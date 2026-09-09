import type {
  ConnectorConfig,
  ForwardingConfig,
  HeaderForwardingConfig,
  RequestForwardingConfig,
  ResponseForwardingConfig,
} from "./config.ts";
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

export type YamlRequestForwardingConfig = RequestForwardingConfig;
export type YamlResponseForwardingConfig = ResponseForwardingConfig;
export type YamlForwardingConfig = ForwardingConfig;

export type YamlValueContext = {
  requestId: string;
  startedAt: string;
  env: Record<string, string>;
};

export type YamlForwardingExecutorOptions = {
  config: ConnectorConfig;
  configPath: string;
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

  static create(
    options: YamlForwardingExecutorOptions,
  ): YamlForwardingExecutor {
    const forwarding = options.config.forwarding;
    const env = options.env ?? Deno.env.toObject();
    const targetBase = resolveTargetTemplate(
      forwarding.target,
      env,
      options.configPath,
    );
    // Resolve and validate the target during startup, not on the first request.
    parseTargetUrl(targetBase, "/", options.configPath);
    const logger = options.logger ?? createLogger(options.config.logLevel);
    logger.info(
      `Activated YAML forwarding configuration from ${options.configPath}`,
    );

    return new YamlForwardingExecutor(
      forwarding,
      targetBase,
      options.configPath,
      env,
      logger,
      createAllowlistedFetch(
        forwarding.outboundUrlAllowlist,
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
    const context: YamlValueContext = {
      requestId: frame.requestId,
      startedAt: new Date().toISOString(),
      env: this.env,
    };

    if (this.forwarding.request) {
      forwardedRequest = applyYamlRequestForwardingConfig(
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
      response = applyYamlResponseForwardingConfig(
        this.forwarding.response,
        response,
        context,
      );
    }
    return response;
  }
}

export function createYamlForwardingExecutor(
  options: YamlForwardingExecutorOptions,
): Promise<YamlForwardingExecutor> {
  try {
    return Promise.resolve(YamlForwardingExecutor.create(options));
  } catch (error) {
    return Promise.reject(error);
  }
}

export function applyYamlRequestForwardingConfig(
  config: YamlRequestForwardingConfig,
  request: CloudConnectorHttpRequest,
  context: YamlValueContext,
): CloudConnectorHttpRequest {
  const result = { ...request, headers: { ...request.headers } };
  if (config.headers) {
    result.headers = applyHeaderConfig(
      result.headers ?? {},
      config.headers,
      context,
    );
  }
  if (config.pathPrefix) {
    result.url = applyPathPrefix(result.url, config.pathPrefix);
  }
  return result;
}

export function applyYamlResponseForwardingConfig(
  config: YamlResponseForwardingConfig,
  response: CloudConnectorHttpResponse,
  context: YamlValueContext,
): CloudConnectorHttpResponse {
  const result = { ...response, headers: { ...response.headers } };
  if (config.headers) {
    result.headers = applyHeaderConfig(
      result.headers ?? {},
      config.headers,
      context,
    );
  }
  return result;
}

export function interpolate(
  template: string,
  context: YamlValueContext,
): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expression: string) => {
    return resolveExpression(expression.trim(), context);
  });
}

function applyHeaderConfig(
  headers: NonNullable<CloudConnectorHttpRequest["headers"]>,
  config: HeaderForwardingConfig,
  context: YamlValueContext,
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

function applyPathPrefix(
  url: string,
  prefix: string,
): string {
  const parsed = new URL(url, "http://cloud-connector.invalid");
  const normalizedPrefix = prefix === "/" ? "" : prefix.replace(/\/$/, "");
  return `${normalizedPrefix}${parsed.pathname}${parsed.search}`;
}

function resolveExpression(
  expression: string,
  context: YamlValueContext,
): string {
  const parts = expression.split(".");
  if (parts[0] === "env" && parts.length === 2) {
    return context.env[parts[1]] ?? "";
  }
  if (parts[0] === "context") {
    if (parts[1] === "requestId") return context.requestId;
    if (parts[1] === "startedAt") return context.startedAt;
  }
  return "";
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
