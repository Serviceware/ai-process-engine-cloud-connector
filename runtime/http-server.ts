import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import type { RuntimeLogger } from "./logger.ts";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export type ServeOptions = {
  hostname: string;
  port: number;
  signal: AbortSignal;
  logger: RuntimeLogger;
};

/**
 * Serves a Fetch API handler with `node:http`. Resolves once the port is
 * bound and rejects when it cannot be bound. Aborting the signal closes the
 * server and its open connections.
 */
export async function serve(
  handler: FetchHandler,
  options: ServeOptions,
): Promise<Server> {
  const server = createServer((incoming, outgoing) => {
    respond(handler, incoming, outgoing).catch((error) => {
      options.logger.error(
        `HTTP request ${incoming.method} ${incoming.url} failed`,
        error,
      );
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    });
  });
  server.listen(options.port, options.hostname);
  await once(server, "listening");
  server.on("error", (error) =>
    options.logger.error("HTTP server error", error),
  );

  const close = () => {
    server.close();
    server.closeAllConnections();
  };
  if (options.signal.aborted) close();
  else options.signal.addEventListener("abort", close, { once: true });
  return server;
}

async function respond(
  handler: FetchHandler,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  const response = await handler(toRequest(incoming));
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    const existing = headers[name];
    headers[name] = existing === undefined ? value : [existing, value].flat();
  });
  outgoing.writeHead(response.status, headers);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function toRequest(incoming: IncomingMessage): Request {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
  }
  const method = incoming.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(new URL(incoming.url ?? "/", "http://localhost"), {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(incoming) as ReadableStream) : undefined,
    duplex: "half",
  });
}
