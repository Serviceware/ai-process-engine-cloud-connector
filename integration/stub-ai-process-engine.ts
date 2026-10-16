import type {
  CloudConnectorHttpRequest,
  CloudConnectorResponseFrame,
} from "../runtime/generated/models.ts";
import { waitFor } from "./wait.ts";

export type StubAiProcessEngineOptions = {
  clientId: string;
  clientSecret: string;
};

export type TokenRequest = {
  grantType: string | null;
  clientId: string | null;
  clientSecret: string | null;
};

type ReceivedFrame = Record<string, unknown> & { type: string };

export class StubConnection {
  readonly frames: ReceivedFrame[] = [];
  readonly closed: Promise<void>;
  readonly purpose: string;
  readonly authorization: string | null;
  private readonly socket: WebSocket;

  constructor(
    socket: WebSocket,
    purpose: string,
    authorization: string | null,
  ) {
    this.socket = socket;
    this.purpose = purpose;
    this.authorization = authorization;
    this.closed = new Promise((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    socket.addEventListener("message", (event) => {
      this.frames.push(JSON.parse(String(event.data)) as ReceivedFrame);
    });
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send(data: string): void {
    this.socket.send(data);
  }

  async request(
    request: CloudConnectorHttpRequest,
    requestId: string = crypto.randomUUID(),
  ): Promise<CloudConnectorResponseFrame> {
    this.send(JSON.stringify({ type: "request", requestId, request }));
    return await this.waitForFrame(
      (frame) => frame.type === "response" && frame.requestId === requestId,
      `response frame for request ${requestId}`,
    ) as CloudConnectorResponseFrame;
  }

  waitForFrame(
    predicate: (frame: ReceivedFrame) => boolean,
    description: string,
  ): Promise<ReceivedFrame> {
    return waitFor(() => this.frames.find(predicate), description);
  }

  close(): void {
    this.socket.close();
  }
}

export class StubAiProcessEngine {
  readonly tokenRequests: TokenRequest[] = [];
  readonly connections: StubConnection[] = [];
  readonly accessToken = `stub-token-${crypto.randomUUID()}`;
  private readonly options: StubAiProcessEngineOptions;
  private readonly server: Deno.HttpServer<Deno.NetAddr>;

  private constructor(options: StubAiProcessEngineOptions) {
    this.options = options;
    this.server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => undefined },
      (request) => this.handle(request),
    );
  }

  static start(options: StubAiProcessEngineOptions): StubAiProcessEngine {
    return new StubAiProcessEngine(options);
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.addr.port}`;
  }

  get issuer(): string {
    return `${this.url}/auth/realms/stub`;
  }

  connection(index: number): Promise<StubConnection> {
    return waitFor(
      () => this.connections[index],
      `Cloud Connector WebSocket connection #${index + 1}`,
    );
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      if (connection.isOpen) connection.close();
    }
    await Promise.all(this.connections.map((connection) => connection.closed));
    await this.server.shutdown();
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/.well-known") {
      return Response.json({ auth: { issuer: this.issuer } });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/auth/realms/stub/protocol/openid-connect/token"
    ) {
      const form = new URLSearchParams(await request.text());
      const tokenRequest: TokenRequest = {
        grantType: form.get("grant_type"),
        clientId: form.get("client_id"),
        clientSecret: form.get("client_secret"),
      };
      this.tokenRequests.push(tokenRequest);
      if (
        tokenRequest.grantType !== "client_credentials" ||
        tokenRequest.clientId !== this.options.clientId ||
        tokenRequest.clientSecret !== this.options.clientSecret
      ) {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      return Response.json({
        access_token: this.accessToken,
        token_type: "Bearer",
        expires_in: 300,
      });
    }

    const connect = url.pathname.match(
      /^\/configuration-store\/api\/v1\/connector\/([^/]+)\/connect$/,
    );
    if (connect && request.headers.get("upgrade") === "websocket") {
      const authorization = request.headers.get("authorization");
      if (authorization !== `Bearer ${this.accessToken}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.addEventListener("open", () => {
        this.connections.push(
          new StubConnection(
            socket,
            decodeURIComponent(connect[1]),
            authorization,
          ),
        );
      }, { once: true });
      return response;
    }

    return new Response("Not found", { status: 404 });
  }
}
