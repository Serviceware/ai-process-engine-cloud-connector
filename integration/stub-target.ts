export type TargetRequest = {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
};

export type TargetHandler = (
  request: TargetRequest,
) => Response | Promise<Response>;

export class StubTarget {
  readonly requests: TargetRequest[] = [];
  private readonly abortController = new AbortController();
  private readonly server: Deno.HttpServer<Deno.NetAddr>;

  private constructor(handler: TargetHandler) {
    this.server = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        signal: this.abortController.signal,
        onListen: () => undefined,
      },
      async (request) => {
        const recorded: TargetRequest = {
          method: request.method,
          url: new URL(request.url),
          headers: request.headers,
          body: await request.text(),
        };
        this.requests.push(recorded);
        return await handler(recorded);
      },
    );
  }

  static start(
    handler: TargetHandler = () => Response.json({ ok: true }),
  ): StubTarget {
    return new StubTarget(handler);
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.addr.port}`;
  }

  /** Aborts instead of draining, so handlers a failed test left waiting cannot block teardown. */
  async close(): Promise<void> {
    this.abortController.abort();
    await this.server.finished;
  }
}
