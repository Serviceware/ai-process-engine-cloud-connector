import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fetch } from "undici";
import { afterEach, expect, test, vi } from "vitest";
import { createHttpDispatcher, httpDispatcherOptions, recordFailure } from "./http-dispatcher.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("createHttpDispatcher forwards plain HTTP to HTTP_PROXY in absolute form", async () => {
  const proxied: string[] = [];
  const proxy = createServer((request, response) => {
    proxied.push(`${request.method} ${request.url}`);
    response.end("via proxy");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const { port } = proxy.address() as AddressInfo;
    // undici prefers the lowercase names. Stubbing both breaks restoring them on Windows, where names ignore case.
    vi.stubEnv("http_proxy", `http://127.0.0.1:${port}`);
    vi.stubEnv("no_proxy", "");
    const dispatcher = createHttpDispatcher();

    const response = await fetch("http://internal.example/items", {
      dispatcher,
    });

    expect(await response.text()).toStrictEqual("via proxy");
    expect(proxied).toStrictEqual(["GET http://internal.example/items"]);
    await dispatcher.close();
  } finally {
    proxy.closeAllConnections();
    proxy.close();
  }
});

test("httpDispatcherOptions lift the connect limit for every hop", () => {
  expect(httpDispatcherOptions).toStrictEqual({
    connect: { timeout: 0 },
    proxyTls: { timeout: 0 },
    requestTls: { timeout: 0 },
    proxyTunnel: false,
  });
});

async function webSocketFailure(url: string): Promise<string | undefined> {
  let failure: string | undefined;
  const socket = new WebSocket(url, {
    dispatcher: createHttpDispatcher().compose(recordFailure((reason) => (failure = reason))),
  });
  await once(socket, "error");
  return failure;
}

test("recordFailure reports the status of a rejected WebSocket upgrade", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    expect(await webSocketFailure(`ws://127.0.0.1:${port}/socket`)).toStrictEqual("HTTP 401 Unauthorized");
  } finally {
    server.close();
  }
});

test("recordFailure reports the network error of a WebSocket that cannot connect", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");

  expect(await webSocketFailure(`ws://127.0.0.1:${port}/socket`)).toStrictEqual(
    `connect ECONNREFUSED 127.0.0.1:${port} (ECONNREFUSED)`,
  );
});
