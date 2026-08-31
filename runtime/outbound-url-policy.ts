import { RuntimeError } from "./runtime-error.ts";

export type Fetcher = typeof globalThis.fetch;

const unrestrictedFetch = globalThis.fetch.bind(globalThis) as Fetcher;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maximumRedirects = 20;

/**
 * Fetch implementation reserved for the Cloud Connector control plane.
 * Workload traffic must use an allowlisted fetch created below.
 */
export const fetchWithoutOutboundUrlPolicy: Fetcher = unrestrictedFetch;

export class OutboundUrlAllowlist {
  private readonly patterns: readonly RegExp[];

  constructor(patterns: readonly string[]) {
    this.patterns = patterns.map((pattern) => new RegExp(pattern, "u"));
  }

  allows(input: string | URL): boolean {
    const url = input instanceof URL ? input : new URL(input);
    return this.patterns.some((pattern) => pattern.test(url.href));
  }

  assertAllows(input: string | URL): URL {
    const url = input instanceof URL ? input : new URL(input);
    if (!this.allows(url)) {
      throw new RuntimeError(
        "OUTBOUND_URL_NOT_ALLOWED",
        `Outbound URL is not allowed by OUTBOUND_URL_ALLOWLIST: ${
          displayUrl(url)
        }`,
      );
    }
    return url;
  }
}

/**
 * Builds a fetch implementation that denies every initial and redirect URL
 * unless at least one configured regular expression matches the normalized,
 * absolute URL.
 */
export function createAllowlistedFetch(
  patterns: readonly string[],
  nextFetch: Fetcher = unrestrictedFetch,
): Fetcher {
  const allowlist = new OutboundUrlAllowlist(patterns);

  return (async (input, init) => {
    let request = new Request(input, init);
    const redirectMode = request.redirect;
    let redirectsFollowed = 0;

    while (true) {
      allowlist.assertAllows(request.url);
      const replayableRequest = request.clone();
      const response = await nextFetch(request, { redirect: "manual" });

      if (!redirectStatuses.has(response.status)) {
        return response;
      }

      const location = response.headers.get("location");
      if (!location || redirectMode === "manual") {
        return response;
      }

      await response.body?.cancel();

      if (redirectMode === "error") {
        throw new TypeError(
          "Redirect encountered while redirect mode is error",
        );
      }
      if (redirectsFollowed >= maximumRedirects) {
        throw new TypeError(`Too many redirects (maximum ${maximumRedirects})`);
      }

      const redirectUrl = new URL(location, request.url);
      request = createRedirectRequest(
        replayableRequest,
        redirectUrl,
        response.status,
      );
      redirectsFollowed += 1;
    }
  }) as Fetcher;
}

/** Installs the default-deny policy for direct fetch calls in function code. */
export function installOutboundUrlPolicy(
  patterns: readonly string[],
): () => void {
  const previousFetch = globalThis.fetch;
  const guardedFetch = createAllowlistedFetch(patterns);
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: guardedFetch,
  });

  return () => {
    if (globalThis.fetch !== guardedFetch) {
      return;
    }
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: previousFetch,
    });
  };
}

function createRedirectRequest(
  source: Request,
  target: URL,
  status: number,
): Request {
  const headers = new Headers(source.headers);
  const switchesToGet = status === 303 && source.method !== "HEAD" ||
    (status === 301 || status === 302) && source.method === "POST";

  if (switchesToGet) {
    for (
      const name of [
        "content-encoding",
        "content-language",
        "content-length",
        "content-location",
        "content-type",
      ]
    ) {
      headers.delete(name);
    }
  }

  if (new URL(source.url).origin !== target.origin) {
    for (
      const name of [
        "authorization",
        "cookie",
        "cookie2",
        "proxy-authorization",
      ]
    ) {
      headers.delete(name);
    }
  }

  if (switchesToGet) {
    return new Request(target, {
      cache: source.cache,
      credentials: source.credentials,
      headers,
      integrity: source.integrity,
      keepalive: source.keepalive,
      method: "GET",
      mode: source.mode,
      redirect: source.redirect,
      referrer: source.referrer,
      referrerPolicy: source.referrerPolicy,
      signal: source.signal,
    });
  }

  return new Request(new Request(target, source), { headers });
}

function displayUrl(url: URL): string {
  if (url.origin === "null") {
    return url.protocol;
  }
  return `${url.origin}${url.pathname}`;
}
