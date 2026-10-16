import { type Dispatcher, EnvHttpProxyAgent } from "undici";

/**
 * Honors HTTP_PROXY, HTTPS_PROXY, and NO_PROXY. undici's fixed 10-second
 * connect limit is disabled because every caller bounds its request with the
 * configured timeout instead.
 */
export function createHttpDispatcher(): Dispatcher {
  return new EnvHttpProxyAgent({ connect: { timeout: 0 } });
}
