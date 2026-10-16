import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type {
  CloudConnectorHttpRequest,
  CloudConnectorResponseFrame,
} from "../runtime/generated/models.ts";
import { serve } from "../runtime/http-server.ts";
import { createLogger } from "../runtime/logger.ts";
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
      socket.once("close", () => resolve());
    });
    socket.on("message", (data) => {
      this.frames.push(JSON.parse(String(data)) as ReceivedFrame);
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
    requestId: string = randomUUID(),
  ): Promise<CloudConnectorResponseFrame> {
    this.send(JSON.stringify({ type: "request", requestId, request }));
    return (await this.waitForFrame(
      (frame) => frame.type === "response" && frame.requestId === requestId,
      `response frame for request ${requestId}`,
    )) as CloudConnectorResponseFrame;
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
  readonly issuedTokens: string[] = [];
  acceptConnections = true;
  private readonly options: StubAiProcessEngineOptions;
  private readonly abortController = new AbortController();
  private readonly webSockets = new WebSocketServer({ noServer: true });
  private server!: Server;

  private constructor(options: StubAiProcessEngineOptions) {
    this.options = options;
  }

  static async start(
    options: StubAiProcessEngineOptions,
  ): Promise<StubAiProcessEngine> {
    const engine = new StubAiProcessEngine(options);
    engine.server = await serve((request) => engine.handle(request), {
      hostname: "127.0.0.1",
      port: 0,
      signal: engine.abortController.signal,
      logger: createLogger("error"),
    });
    engine.server.on("upgrade", (request, socket, head) =>
      engine.upgrade(request, socket, head),
    );
    return engine;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
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
    this.webSockets.close();
    const closed = new Promise((resolve) => this.server.once("close", resolve));
    this.abortController.abort();
    await closed;
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
      const accessToken = `stub-token-${randomUUID()}`;
      this.issuedTokens.push(accessToken);
      return Response.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 300,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  private upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const url = new URL(request.url ?? "/", this.url);
    const connect = url.pathname.match(
      /^\/configuration-store\/api\/v1\/connector\/([^/]+)\/connect$/,
    );
    const authorization = request.headers.authorization ?? null;
    if (!connect) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!this.acceptConnections) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    if (authorization !== `Bearer ${this.issuedTokens.at(-1)}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      this.connections.push(
        new StubConnection(
          webSocket,
          decodeURIComponent(connect[1]),
          authorization,
        ),
      );
    });
  }
}
