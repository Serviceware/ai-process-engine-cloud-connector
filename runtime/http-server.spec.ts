import { once } from "node:events";
import { type AddressInfo, connect } from "node:net";
import { expect, test } from "vitest";
import { serve } from "./http-server.ts";
import { createLogger } from "./logger.ts";

const errors: unknown[][] = [];
const logger = createLogger("error", {
  debug: () => undefined,
  error: (...data) => errors.push(data),
  info: () => undefined,
  warn: () => undefined,
});

test("serve passes requests to the handler and writes its responses", async () => {
  const abortController = new AbortController();
  const server = await serve(
    async (request) => {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return Response.json(
        {
          method: request.method,
          path: new URL(request.url).pathname,
          search: new URL(request.url).search,
          header: request.headers.get("x-test"),
          body: await request.text(),
        },
        { status: 201, headers },
      );
    },
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abortController.signal,
      logger,
    },
  );

  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/items?id=1`, {
      method: "POST",
      headers: { "x-test": "value" },
      body: "payload",
    });

    expect(response.status).toStrictEqual(201);
    expect(response.headers.getSetCookie()).toStrictEqual(["a=1", "b=2"]);
    expect(await response.json()).toStrictEqual({
      method: "POST",
      path: "/items",
      search: "?id=1",
      header: "value",
      body: "payload",
    });
  } finally {
    abortController.abort();
  }
  await once(server, "close");
});

test("serve answers 500 and logs when the handler fails", async () => {
  errors.length = 0;
  const abortController = new AbortController();
  const server = await serve(
    () => {
      throw new Error("handler failed");
    },
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abortController.signal,
      logger,
    },
  );

  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/broken`);

    expect(response.status).toStrictEqual(500);
    expect(errors).toHaveLength(1);
  } finally {
    abortController.abort();
  }
});

test("serve rejects when the port cannot be bound", async () => {
  const abortController = new AbortController();
  const options = {
    hostname: "127.0.0.1",
    port: 0,
    signal: abortController.signal,
    logger,
  };
  const first = await serve(() => new Response(), options);

  try {
    await expect(
      serve(() => new Response(), {
        ...options,
        port: (first.address() as AddressInfo).port,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "EADDRINUSE" }));
  } finally {
    abortController.abort();
  }
});

test("serve answers request lines the Fetch API cannot represent", async () => {
  const abortController = new AbortController();
  const server = await serve(
    (request) =>
      new URL(request.url).pathname === "/health"
        ? new Response("ok")
        : new Response("Not found", { status: 404 }),
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abortController.signal,
      logger,
    },
  );
  const errorsBefore = errors.length;

  try {
    const port = (server.address() as AddressInfo).port;
    const statusLine = async (requestLine: string) => {
      const socket = connect(port, "127.0.0.1");
      await once(socket, "connect");
      socket.end(`${requestLine}\r\nHost: localhost\r\n\r\n`);
      let response = "";
      for await (const chunk of socket) response += chunk;
      return response.split("\r\n")[0];
    };

    expect(await statusLine("GET // HTTP/1.1")).toStrictEqual(
      "HTTP/1.1 404 Not Found",
    );
    expect(await statusLine("GET * HTTP/1.1")).toStrictEqual(
      "HTTP/1.1 400 Bad Request",
    );
    expect(await statusLine("TRACE /health HTTP/1.1")).toStrictEqual(
      "HTTP/1.1 405 Method Not Allowed",
    );
    expect(await statusLine("TRACK /health HTTP/1.1")).toStrictEqual(
      "HTTP/1.1 400 Bad Request",
    );
    expect(await statusLine("CONNECT localhost:1 HTTP/1.1")).toStrictEqual(
      "HTTP/1.1 405 Method Not Allowed",
    );
    expect(errors.length).toStrictEqual(errorsBefore);
  } finally {
    abortController.abort();
  }
});
