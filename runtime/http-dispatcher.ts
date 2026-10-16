import { type Dispatcher, EnvHttpProxyAgent } from "undici";

const noConnectLimit = { timeout: 0 };

/**
 * Honors HTTP_PROXY, HTTPS_PROXY, and NO_PROXY and sends plain HTTP to the
 * proxy in absolute form, as many proxies refuse CONNECT to port 80. undici's
 * fixed 10-second connect limit is disabled for targets, proxies, and tunneled
 * TLS handshakes because every caller bounds its request with the configured
 * timeout instead.
 */
export function createHttpDispatcher(): Dispatcher {
  return new EnvHttpProxyAgent(httpDispatcherOptions);
}

export const httpDispatcherOptions = {
  connect: noConnectLimit,
  proxyTls: noConnectLimit,
  requestTls: noConnectLimit,
  proxyTunnel: false,
};
