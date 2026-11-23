import type { Duplex } from "node:stream";
import { type Dispatcher, EnvHttpProxyAgent } from "undici";
import { describeError } from "./runtime-error.ts";

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

/**
 * Reports why a request failed: the network error or a status that is not a
 * WebSocket upgrade. Node's WebSocket drops both and fires an empty error event.
 * Only the first reason counts; the abort that follows a rejected upgrade does not.
 */
export function recordFailure(record: (reason: string) => void): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) => (options, handler) => {
    let reported = false;
    const report = (reason: string) => {
      if (reported) return;
      reported = true;
      record(reason);
    };
    return dispatch(options, {
      onRequestStart: (controller, context) => handler.onRequestStart?.(controller, context),
      onRequestUpgrade: (controller, statusCode, headers, socket) =>
        handler.onRequestUpgrade?.(controller, statusCode, headers, socket),
      onResponseStart: (controller, statusCode, headers, statusMessage) => {
        report(`HTTP ${statusCode}${statusMessage ? ` ${statusMessage}` : ""}`);
        handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
      },
      onResponseData: (controller, chunk) => handler.onResponseData?.(controller, chunk),
      onResponseEnd: (controller, trailers) => handler.onResponseEnd?.(controller, trailers),
      onResponseError: (controller, error) => {
        report(describeError(error));
        handler.onResponseError?.(controller, error);
      },
    });
  };
}

/**
 * Hands the connection of a successful upgrade to `capture`. Node's WebSocket
 * never gives up on a close handshake the peer does not answer: the socket
 * stays CLOSING, keeps its connection open, and drops inbound frames. Only
 * destroying this connection ends it.
 */
export function captureUpgrade(capture: (socket: Duplex) => void): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) => (options, handler) =>
    dispatch(options, {
      onRequestStart: (controller, context) => handler.onRequestStart?.(controller, context),
      onRequestUpgrade: (controller, statusCode, headers, socket) => {
        capture(socket);
        handler.onRequestUpgrade?.(controller, statusCode, headers, socket);
      },
      onResponseStart: (controller, statusCode, headers, statusMessage) =>
        handler.onResponseStart?.(controller, statusCode, headers, statusMessage),
      onResponseData: (controller, chunk) => handler.onResponseData?.(controller, chunk),
      onResponseEnd: (controller, trailers) => handler.onResponseEnd?.(controller, trailers),
      onResponseError: (controller, error) => handler.onResponseError?.(controller, error),
    });
}
