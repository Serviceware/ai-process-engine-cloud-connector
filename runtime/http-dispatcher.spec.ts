import { once } from "node:events";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { fetch } from "undici";
import { afterEach, expect, test, vi } from "vitest";
import { createHttpDispatcher } from "./http-dispatcher.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("createHttpDispatcher tunnels requests through HTTP_PROXY", async () => {
  const target = createServer((_request, response) => response.end("tunneled"));
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const tunnels: string[] = [];
  const proxy = createServer();
  proxy.on("connect", (request, client) => {
    tunnels.push(request.url ?? "");
    const upstream = connect(
      (target.address() as AddressInfo).port,
      "127.0.0.1",
      () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client).pipe(upstream);
      },
    );
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const { port } = proxy.address() as AddressInfo;
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${port}`);
    vi.stubEnv("NO_PROXY", "");
    const dispatcher = createHttpDispatcher();

    const response = await fetch("http://internal.example/items", {
      dispatcher,
    });

    expect(await response.text()).toStrictEqual("tunneled");
    expect(tunnels).toStrictEqual(["internal.example:80"]);
    await dispatcher.close();
  } finally {
    proxy.closeAllConnections();
    proxy.close();
    target.closeAllConnections();
    target.close();
  }
});
