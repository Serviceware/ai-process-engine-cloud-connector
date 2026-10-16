import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fetch } from "undici";
import { afterEach, expect, test, vi } from "vitest";
import { createHttpDispatcher, httpDispatcherOptions } from "./http-dispatcher.ts";

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
