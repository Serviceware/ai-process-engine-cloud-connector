import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { serve } from "../runtime/http-server.ts";
import { createLogger } from "../runtime/logger.ts";

export type TargetRequest = {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
};

export type TargetHandler = (request: TargetRequest) => Response | Promise<Response>;

export class StubTarget {
  readonly requests: TargetRequest[];
  private readonly server: Server;
  private readonly abortController: AbortController;

  private constructor(requests: TargetRequest[], server: Server, abortController: AbortController) {
    this.requests = requests;
    this.server = server;
    this.abortController = abortController;
  }

  static async start(handler: TargetHandler = () => Response.json({ ok: true })): Promise<StubTarget> {
    const abortController = new AbortController();
    const requests: TargetRequest[] = [];
    const server = await serve(
      async (request) => {
        const recorded: TargetRequest = {
          method: request.method,
          url: new URL(request.url),
          headers: request.headers,
          body: await request.text(),
        };
        requests.push(recorded);
        return await handler(recorded);
      },
      {
        hostname: "127.0.0.1",
        port: 0,
        signal: abortController.signal,
        logger: createLogger("error"),
      },
    );
    return new StubTarget(requests, server, abortController);
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    const closed = new Promise((resolve) => this.server.once("close", resolve));
    this.abortController.abort();
    await closed;
  }
}
