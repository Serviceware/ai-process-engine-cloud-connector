import type {
  AuthConfig,
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
  oauthTokenCache?: OAuthTokenCache;
};

type CompiledRule = {
  config: ForwardingConfig;
  matcher: RegExp;
};

type OAuthToken = {
  token: string;
  expiresAt: number;
};

export type OAuthTokenCache = {
  tokens: Map<string, OAuthToken>;
  inFlight: Map<string, Promise<string>>;
};

export function createOAuthTokenCache(): OAuthTokenCache {
  return { tokens: new Map(), inFlight: new Map() };
}

/**
 * The complete inbound URL is authorized by one or more ordered YAML rules.
 * Matching rules are merged in declaration order, with later explicit values
 * taking precedence.
 */
export class YamlForwardingExecutor implements ProtocolExecutor {
  private constructor(
    private readonly rules: readonly CompiledRule[],
    private readonly configPath: string,
    private readonly env: Record<string, string>,
    private readonly logger: RuntimeLogger,
    private readonly fetcher: Fetcher,
    private readonly tokenFetcher: Fetcher,
    private readonly oauthTokenCache: OAuthTokenCache,
    private readonly maxResponseBodyBytes: number,
  ) {}

  static create(
    options: YamlForwardingExecutorOptions,
  ): YamlForwardingExecutor {
    const rules = options.config.forwarding.map((config) => ({
      config,
      matcher: new RegExp(config.target, "u"),
    }));
    const logger = options.logger ?? createLogger(options.config.logLevel);
    logger.info(
      `Activated ${rules.length} YAML forwarding rule(s) from ${options.configPath}`,
    );
    const nextFetch = options.nextFetch ?? globalThis.fetch.bind(globalThis);

    return new YamlForwardingExecutor(
      rules,
      options.configPath,
      options.env ?? Deno.env.toObject(),
      logger,
      nextFetch,
      nextFetch,
      options.oauthTokenCache ?? createOAuthTokenCache(),
      options.config.maxResponseBodyBytes,
    );
  }

  async execute(
    frame: CloudConnectorRequestFrame,
  ): Promise<CloudConnectorHttpResponse> {
    const targetUrl = parseRequestedUrl(frame.request.url, this.configPath);
    const matchingRules = this.rules
      .filter((rule) => rule.matcher.test(targetUrl.href))
      .map((rule) => rule.config);
    if (matchingRules.length === 0) {
      throw new RuntimeError(
        "OUTBOUND_URL_NOT_ALLOWED",
        `Requested URL is not allowed by any forwarding target rule in ${this.configPath}`,
      );
    }

    const forwarding = mergeForwardingConfigs(matchingRules);
    if (
      forwarding.methods && !forwarding.methods.includes(frame.request.method)
    ) {
      throw new RuntimeError(
        "METHOD_NOT_ALLOWED",
        `Method ${frame.request.method} is not enabled by ${this.configPath}`,
      );
    }

    const context: YamlValueContext = {
      requestId: frame.requestId,
      startedAt: new Date().toISOString(),
      env: this.env,
    };
    let forwardedRequest: CloudConnectorHttpRequest = {
      ...frame.request,
      url: targetUrl.href,
      headers: { ...frame.request.headers },
    };
    if (!forwarding.request?.forwardIncomingCredentials) {
      for (
        const name of [
          "authorization",
          "cookie",
          "cookie2",
          "proxy-authorization",
        ]
      ) {
        deleteHeader(forwardedRequest.headers ?? {}, name);
      }
    }
    if (forwarding.request) {
      forwardedRequest = applyYamlRequestForwardingConfig(
        forwarding.request,
        forwardedRequest,
        context,
      );
      if (forwarding.request.auth) {
        forwardedRequest = await this.applyAuth(
          forwarding.request.auth,
          forwardedRequest,
          context,
          effectiveTimeout(forwarding.timeout, frame.request.timeoutSeconds),
        );
      }
    }

    const finalUrl = parseRequestedUrl(forwardedRequest.url, this.configPath);
    const headers = buildHeaders(forwardedRequest.headers);
    removeHopByHopHeaders(headers);
    this.logger.info(
      `Forwarding request ${frame.requestId}: ${forwardedRequest.method} to ${finalUrl.origin}`,
    );

    const timeout = effectiveTimeout(
      forwarding.timeout,
      frame.request.timeoutSeconds,
    );
    const fetcher = createAllowlistedFetch(
      matchingRules.map((rule) => rule.target),
      this.fetcher,
    );
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetcher(finalUrl, {
        method: forwardedRequest.method,
        headers,
        body: forwardedRequest.method === "GET" ||
            forwardedRequest.method === "HEAD"
          ? undefined
          : forwardedRequest.body ?? undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
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
      body: await readBoundedText(
        upstreamResponse,
        this.maxResponseBodyBytes,
      ),
    };
    if (forwarding.response) {
      response = applyYamlResponseForwardingConfig(
        forwarding.response,
        response,
        context,
      );
    }
    return response;
  }

  private async applyAuth(
    auth: AuthConfig,
    request: CloudConnectorHttpRequest,
    context: YamlValueContext,
    timeout: number,
  ): Promise<CloudConnectorHttpRequest> {
    let value: string;
    if (auth.type === "basic") {
      const username = requiredInterpolated(auth.username, context, "username");
      const password = requiredInterpolated(auth.password, context, "password");
      value = `Basic ${encodeBase64(`${username}:${password}`)}`;
    } else if (auth.type === "bearer") {
      value = `Bearer ${requiredInterpolated(auth.token, context, "token")}`;
    } else {
      value = `Bearer ${await this.getOAuthToken(auth, context, timeout)}`;
    }
    const headers = { ...request.headers };
    deleteHeader(headers, "authorization");
    headers.authorization = [value];
    return { ...request, headers };
  }

  private async getOAuthToken(
    auth: Extract<AuthConfig, { type: "oauth2" }>,
    context: YamlValueContext,
    timeout: number,
  ): Promise<string> {
    const issuer = requiredInterpolated(auth.issuer, context, "issuer");
    const clientId = requiredInterpolated(auth.clientId, context, "clientId");
    const clientSecret = requiredInterpolated(
      auth.clientSecret,
      context,
      "clientSecret",
    );
    const scope = auth.scope
      ? requiredInterpolated(auth.scope, context, "scope")
      : undefined;
    const cacheKey = JSON.stringify([issuer, clientId, clientSecret, scope]);
    const cached = this.oauthTokenCache.tokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 5_000) return cached.token;

    const inFlight = this.oauthTokenCache.inFlight.get(cacheKey);
    if (inFlight) return await inFlight;

    const request = this.fetchOAuthToken(
      issuer,
      clientId,
      clientSecret,
      scope,
      timeout,
      cacheKey,
    );
    this.oauthTokenCache.inFlight.set(cacheKey, request);
    try {
      return await request;
    } finally {
      this.oauthTokenCache.inFlight.delete(cacheKey);
    }
  }

  private async fetchOAuthToken(
    issuer: string,
    clientId: string,
    clientSecret: string,
    scope: string | undefined,
    timeout: number,
    cacheKey: string,
  ): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (scope) body.set("scope", scope);
    let response: Response;
    try {
      response = await this.tokenFetcher(issuer, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new RuntimeError(
        "TARGET_REQUEST_ERROR",
        "OAuth2 token request failed",
        {
          cause: error,
        },
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new RuntimeError(
        "TARGET_REQUEST_ERROR",
        `OAuth2 token endpoint returned HTTP ${response.status}`,
      );
    }
    const payload = await response.json() as Record<string, unknown>;
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new RuntimeError(
        "TARGET_REQUEST_ERROR",
        "OAuth2 token response does not contain access_token",
      );
    }
    const expiresIn = typeof payload.expires_in === "number" &&
        Number.isFinite(payload.expires_in) && payload.expires_in > 0
      ? payload.expires_in
      : 300;
    this.oauthTokenCache.tokens.set(cacheKey, {
      token: payload.access_token,
      expiresAt: Date.now() + expiresIn * 1_000,
    });
    return payload.access_token;
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

export function mergeForwardingConfigs(
  configs: readonly ForwardingConfig[],
): ForwardingConfig {
  const result: ForwardingConfig = { target: configs.at(-1)?.target ?? "" };
  for (const config of configs) {
    if (config.methods !== undefined) result.methods = [...config.methods];
    if (config.timeout !== undefined) result.timeout = config.timeout;
    if (config.request !== undefined) {
      result.request = mergeRequestConfig(result.request, config.request);
    }
    if (config.response !== undefined) {
      result.response = mergeResponseConfig(result.response, config.response);
    }
  }
  const lastAuth = configs.at(-1)?.request?.auth;
  if (result.request !== undefined) result.request.auth = lastAuth;
  return result;
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
  return template.replace(
    /\{\{\s*([^}]+)\s*\}\}/g,
    (_, expression: string) => resolveExpression(expression.trim(), context),
  );
}

function mergeRequestConfig(
  current: RequestForwardingConfig | undefined,
  next: RequestForwardingConfig,
): RequestForwardingConfig {
  return {
    headers: mergeHeaderConfigs(current?.headers, next.headers),
    pathPrefix: next.pathPrefix !== undefined
      ? next.pathPrefix
      : current?.pathPrefix,
    forwardIncomingCredentials: next.forwardIncomingCredentials !== undefined
      ? next.forwardIncomingCredentials
      : current?.forwardIncomingCredentials,
    auth: next.auth,
  };
}

function mergeResponseConfig(
  current: ResponseForwardingConfig | undefined,
  next: ResponseForwardingConfig,
): ResponseForwardingConfig {
  return { headers: mergeHeaderConfigs(current?.headers, next.headers) };
}

function mergeHeaderConfigs(
  current: HeaderForwardingConfig | undefined,
  next: HeaderForwardingConfig | undefined,
): HeaderForwardingConfig | undefined {
  if (!current && !next) return undefined;
  const operations = new Map<
    string,
    {
      kind: "add" | "remove" | "set";
      name: string;
      value?: string | string[];
    }
  >();
  for (const config of [current, next]) {
    if (!config) continue;
    for (const name of config.remove ?? []) {
      operations.set(name.toLowerCase(), { kind: "remove", name });
    }
    for (const [name, value] of Object.entries(config.set ?? {})) {
      operations.set(name.toLowerCase(), { kind: "set", name, value });
    }
    for (const [name, value] of Object.entries(config.add ?? {})) {
      const key = name.toLowerCase();
      const previous = operations.get(key);
      const values = Array.isArray(value) ? value : [value];
      operations.set(key, {
        kind: "add",
        name,
        value: previous?.kind === "add"
          ? [
            ...(Array.isArray(previous.value)
              ? previous.value
              : [previous.value ?? ""]),
            ...values,
          ]
          : values,
      });
    }
  }
  const result: HeaderForwardingConfig = {};
  for (const operation of operations.values()) {
    if (operation.kind === "remove") {
      (result.remove ??= []).push(operation.name);
    } else {
      if (operation.kind === "add") {
        (result.add ??= {})[operation.name] = operation.value ?? "";
      } else {
        (result.set ??= {})[operation.name] = String(operation.value ?? "");
      }
    }
  }
  return result;
}

function applyHeaderConfig(
  headers: NonNullable<CloudConnectorHttpRequest["headers"]>,
  config: HeaderForwardingConfig,
  context: YamlValueContext,
): NonNullable<CloudConnectorHttpRequest["headers"]> {
  const result = { ...headers };
  for (const name of config.remove ?? []) deleteHeader(result, name);
  for (const [name, value] of Object.entries(config.set ?? {})) {
    deleteHeader(result, name);
    result[name] = [interpolate(value, context)];
  }
  for (const [name, value] of Object.entries(config.add ?? {})) {
    const existing = findHeader(result, name);
    if (existing && existing !== name) {
      result[name] = result[existing];
      delete result[existing];
    }
    const additions = Array.isArray(value) ? value : [value];
    result[name] = [
      ...(result[name] ?? []),
      ...additions.map((entry) => interpolate(entry, context)),
    ];
  }
  return result;
}

function applyPathPrefix(url: string, prefix: string): string {
  const parsed = new URL(url);
  const normalizedPrefix = prefix === "/" ? "" : prefix.replace(/\/$/, "");
  parsed.pathname = `${normalizedPrefix}${parsed.pathname}`;
  return parsed.href;
}

function resolveExpression(
  expression: string,
  context: YamlValueContext,
): string {
  const parts = expression.split(".");
  if (parts[0] === "env" && parts.length === 2) {
    return requiredEnvironmentValue(parts[1], context);
  }
  if (expression.startsWith("env:")) {
    return requiredEnvironmentValue(expression.slice(4), context);
  }
  if (parts[0] === "context") {
    if (parts[1] === "requestId") return context.requestId;
    if (parts[1] === "startedAt") return context.startedAt;
  }
  throw new RuntimeError(
    "CONFIG_ERROR",
    `Unsupported forwarding interpolation expression: ${expression}`,
  );
}

function requiredEnvironmentValue(
  name: string,
  context: YamlValueContext,
): string {
  if (!(name in context.env)) {
    throw new RuntimeError(
      "CONFIG_ERROR",
      `Environment variable ${name} referenced by forwarding configuration is not set`,
    );
  }
  return context.env[name];
}

export function effectiveTimeout(
  configuredTimeout: number | undefined,
  requestedTimeoutSeconds: number | undefined,
): number {
  const configured = configuredTimeout ?? 30_000;
  return requestedTimeoutSeconds === undefined
    ? configured
    : Math.min(configured, requestedTimeoutSeconds * 1_000);
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new RuntimeError(
      "RESPONSE_TOO_LARGE",
      `Target response exceeds the ${maximumBytes}-byte limit`,
    );
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maximumBytes) {
      await reader.cancel();
      throw new RuntimeError(
        "RESPONSE_TOO_LARGE",
        `Target response exceeds the ${maximumBytes}-byte limit`,
      );
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return body || null;
}

function parseRequestedUrl(value: string, configPath: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new RuntimeError(
      "OUTBOUND_URL_NOT_ALLOWED",
      `Requested URL must be absolute in ${configPath}`,
      { cause: error },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RuntimeError(
      "OUTBOUND_URL_NOT_ALLOWED",
      `Requested URL must use HTTP or HTTPS in ${configPath}`,
    );
  }
  return url;
}

function requiredInterpolated(
  template: string,
  context: YamlValueContext,
  name: string,
): string {
  const value = interpolate(template, context);
  if (!value) {
    throw new RuntimeError(
      "CONFIG_ERROR",
      `Forwarding authentication ${name} is empty after environment interpolation`,
    );
  }
  return value;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function findHeader(
  headers: Record<string, string[]>,
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === normalized);
}

function deleteHeader(headers: Record<string, string[]>, name: string): void {
  const existing = findHeader(headers, name);
  if (existing) delete headers[existing];
}

function buildHeaders(values: CloudConnectorHttpRequest["headers"]): Headers {
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
  ) headers.delete(name);
}
