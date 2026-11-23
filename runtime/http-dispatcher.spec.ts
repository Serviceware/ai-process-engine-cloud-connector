import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createServer as createSocketServer, type AddressInfo } from "node:net";
import { fetch } from "undici";
import { afterEach, expect, test, vi } from "vitest";
import type { Duplex } from "node:stream";
import { captureUpgrade, createHttpDispatcher, httpDispatcherOptions, recordFailure } from "./http-dispatcher.ts";

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

async function listen(server: Server | ReturnType<typeof createSocketServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

test("recordFailure reports the status of a rejected WebSocket upgrade", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401).end();
  });
  const port = await listen(server);
  try {
    expect(await webSocketFailure(`ws://127.0.0.1:${port}/socket`)).toStrictEqual("HTTP 401 Unauthorized");
  } finally {
    server.close();
  }
});

test("recordFailure reports a status line without a reason phrase by its code", async () => {
  const server = createSocketServer((socket) => {
    socket.end("HTTP/1.1 401\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  const port = await listen(server);
  try {
    expect(await webSocketFailure(`ws://127.0.0.1:${port}/socket`)).toStrictEqual("HTTP 401");
  } finally {
    server.close();
  }
});

test("recordFailure reports only the first reason of a rejected WebSocket upgrade", async () => {
  const server = createSocketServer((socket) => {
    socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial");
    socket.destroy();
  });
  const port = await listen(server);
  const reasons: string[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`, {
    dispatcher: createHttpDispatcher().compose(recordFailure((reason) => reasons.push(reason))),
  });
  const failed = once(socket, "error");
  const closed = once(socket, "close");
  try {
    await Promise.all([failed, closed]);

    expect(reasons).toStrictEqual(["HTTP 403 Forbidden"]);
  } finally {
    server.close();
  }
});

test("recordFailure reports the network error of a WebSocket that cannot connect", async () => {
  const server = createServer();
  const port = await listen(server);
  server.close();
  await once(server, "close");

  expect(await webSocketFailure(`ws://127.0.0.1:${port}/socket`)).toStrictEqual(
    `connect ECONNREFUSED 127.0.0.1:${port} (ECONNREFUSED)`,
  );
});

test("recordFailure keeps a successful WebSocket upgrade open and reports nothing", async () => {
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    const key = String(request.headers["sec-websocket-key"]);
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  const port = await listen(server);
  const reasons: string[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`, {
    dispatcher: createHttpDispatcher().compose(recordFailure((reason) => reasons.push(reason))),
  });
  try {
    await once(socket, "open");

    expect(reasons).toStrictEqual([]);
  } finally {
    socket.close();
    server.closeAllConnections();
    server.close();
  }
});

test("recordFailure passes response bodies through unchanged", async () => {
  const server = createServer((_request, response) => {
    response.end("payload");
  });
  const port = await listen(server);
  try {
    const dispatcher = createHttpDispatcher().compose(recordFailure(() => undefined));
    const response = await fetch(`http://127.0.0.1:${port}/items`, { dispatcher });

    expect(await response.text()).toStrictEqual("payload");
    await dispatcher.close();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("captureUpgrade hands over the connection, and destroying it closes the WebSocket", async () => {
  const server = createServer();
  let clientEndedConnection = false;
  server.on("upgrade", (request, socket) => {
    socket.on("end", () => (clientEndedConnection = true));
    socket.on("data", () => undefined);
    const key = String(request.headers["sec-websocket-key"]);
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  const port = await listen(server);
  const captured: Duplex[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`, {
    dispatcher: createHttpDispatcher().compose(captureUpgrade((connection) => captured.push(connection))),
  });
  try {
    await once(socket, "open");
    expect(captured.length).toStrictEqual(1);

    // The server never answers the close frame; only destroying the connection ends it.
    socket.close();
    captured[0].destroy();
    const [event] = (await once(socket, "close")) as [CloseEvent];

    expect(event.code).toStrictEqual(1006);
    await vi.waitFor(() => expect(clientEndedConnection).toStrictEqual(true));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("captureUpgrade captures nothing for plain requests and passes bodies through", async () => {
  const server = createServer((_request, response) => {
    response.end("payload");
  });
  const port = await listen(server);
  const captured: Duplex[] = [];
  try {
    const dispatcher = createHttpDispatcher().compose(captureUpgrade((connection) => captured.push(connection)));
    const response = await fetch(`http://127.0.0.1:${port}/items`, { dispatcher });

    expect(await response.text()).toStrictEqual("payload");
    expect(captured).toStrictEqual([]);
    await dispatcher.close();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
