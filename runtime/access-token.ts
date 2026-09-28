export type AccessTokenOptions = {
  host: string;
  clientId: string;
  clientSecret: string;
  /** Timeout in ms for each token-related fetch (default 10s). */
  timeoutMs?: number;
  /** External signal (e.g. shutdown) that aborts the fetches promptly. */
  signal?: AbortSignal;
  /** HTTP implementation used by the Cloud Connector control plane. */
  fetcher?: typeof globalThis.fetch;
};

const defaultTokenFetchTimeoutMs = 10_000;

/** Combines the per-fetch timeout with an optional external abort signal. */
function fetchSignal(
  timeoutMs: number,
  external?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

type WellKnownConfiguration = {
  auth?: {
    issuer?: unknown;
  };
};

type TokenResponse = {
  access_token?: unknown;
};

export async function generateAccessToken(
  options: AccessTokenOptions,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? defaultTokenFetchTimeoutMs;
  const fetcher = options.fetcher ?? globalThis.fetch;
  const wellKnownResponse = await fetcher(
    joinUrl(options.host, ".well-known"),
    {
      signal: fetchSignal(timeoutMs, options.signal),
    },
  );
  if (!wellKnownResponse.ok) {
    throw new Error(
      `Failed to fetch well-known configuration: ${wellKnownResponse.statusText}`,
    );
  }

  const wellKnown = await wellKnownResponse.json() as WellKnownConfiguration;
  const authEndpoint = typeof wellKnown.auth?.issuer === "string"
    ? wellKnown.auth.issuer
    : undefined;
  if (!authEndpoint) {
    throw new Error(
      "Authentication endpoint not found in well-known configuration.",
    );
  }
  const configuredOrigin = new URL(options.host).origin;
  const issuer = new URL(authEndpoint);
  const trustedSsoIssuer = issuer.protocol === "https:" &&
    issuer.hostname === "sso.swop.cloud" && issuer.port === "";
  if (
    issuer.username || issuer.password || issuer.search || issuer.hash ||
    (issuer.origin !== configuredOrigin && !trustedSsoIssuer)
  ) {
    throw new Error(
      `Authentication issuer ${issuer.origin} is not allowed for Cloud Connector host origin ${configuredOrigin}.`,
    );
  }

  const tokenResponse = await fetcher(
    joinUrl(issuer.href, "protocol/openid-connect/token"),
    {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: options.clientId,
        client_secret: options.clientSecret,
      }),
      signal: fetchSignal(timeoutMs, options.signal),
    },
  );
  if (!tokenResponse.ok) {
    throw new Error(
      `Failed to obtain access token: ${tokenResponse.statusText}`,
    );
  }

  const tokenData = await tokenResponse.json() as TokenResponse;
  if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
    throw new Error("Access token not found in token response.");
  }

  return tokenData.access_token;
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}
