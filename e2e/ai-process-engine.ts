import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { generateAccessToken } from "../runtime/access-token.ts";
import { waitFor } from "../integration/wait.ts";

const environmentVariables = [
  "E2E_CLOUD_CONNECTOR_HOST",
  "E2E_CLOUD_CONNECTOR_CLIENT_ID",
  "E2E_CLOUD_CONNECTOR_CLIENT_SECRET",
] as const;

export type E2eEnvironment = {
  host: string;
  clientId: string;
  clientSecret: string;
};

/** Reads the variables from the environment, falling back to the git-ignored `.env` in the repository root. */
export function e2eEnvironment(): E2eEnvironment {
  const envFile = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const missing = environmentVariables.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`End-to-end tests need ${missing.join(", ")}; see docs/conventions/TESTING.md`);
  }
  return {
    host: process.env.E2E_CLOUD_CONNECTOR_HOST as string,
    clientId: process.env.E2E_CLOUD_CONNECTOR_CLIENT_ID as string,
    clientSecret: process.env.E2E_CLOUD_CONNECTOR_CLIENT_SECRET as string,
  };
}

export type SendRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  url: string;
  headers?: Record<string, string[]>;
  body?: string;
  initiator?: Initiator;
};

export type Initiator = { type: string; id: string };

export type SendResult = {
  status: number;
  body: string;
};

/** Request log entry, `CloudConnectorHttpRequestInfo`. */
export type LoggedRequest = {
  id: string;
  status: "pending" | "in-progress" | "done" | "failed";
  method: string;
  url: string;
  initiator?: Initiator;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  statusCode?: number;
  errorCode?: string;
  connectorErrorCode?: string;
  connectorErrorMessage?: string;
};

/** `CloudConnectorInfo` */
export type ConnectorInfo = {
  purpose: string;
  status: "connected" | "disconnected";
  activeSessionsCount: number;
  lastHeartbeatAt?: string;
  handledRequestsCountLast24h: number;
  avgRequestDurationMsLast24h: number;
};

/** `CloudConnectorSessionInfo` */
export type SessionInfo = {
  id: string;
  status: "connected" | "disconnected";
  connectedAt: string;
  lastHeartbeatAt: string;
  lastHandledRequestAt?: string;
  disconnectedAt?: string;
  handledRequestsCount: number;
};

/** Client for the Serviceware AI Process Engine Cloud Connector API of one purpose. */
export class AiProcessEngine {
  private readonly environment: E2eEnvironment;
  private readonly purpose: string;
  private accessToken: string | undefined;

  constructor(environment: E2eEnvironment, purpose: string) {
    this.environment = environment;
    this.purpose = purpose;
  }

  /** Asks the platform to send `request` through a connector registered for the purpose. */
  async send(request: SendRequest): Promise<SendResult> {
    const response = await fetch(this.connectorUrl("/http"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.token()}`,
        "content-type": "application/json",
      },
      // Without headers the platform sends `"headers": null`, which the protocol forbids (AB#155556).
      body: JSON.stringify({ headers: {}, ...request, timeoutSeconds: 30 }),
      signal: AbortSignal.timeout(40_000),
    });
    return { status: response.status, body: await response.text() };
  }

  /**
   * Waits until `probe` gets HTTP 200 through the connector; `/ready` only
   * shows that the connector's side of the WebSocket is open.
   */
  async waitUntilRoutable(probe: SendRequest): Promise<void> {
    let last: SendResult | undefined;
    await waitFor(
      async () => {
        last = await this.send(probe);
        if (last.status === 200) return true;
        await sleep(500);
        return undefined;
      },
      `purpose ${this.purpose} to accept requests`,
      30_000,
    ).catch((error: unknown) => {
      throw new Error(`${String(error)}; last response: HTTP ${last?.status} ${last?.body}`, { cause: error });
    });
  }

  /** Request log entries of the purpose that `initiator` started, newest first. */
  async loggedRequests(initiator: Initiator): Promise<LoggedRequest[]> {
    const url = this.connectorUrl("/http");
    url.searchParams.set("initiator", `${initiator.type}:${initiator.id}`);
    return (await this.get<{ requests: LoggedRequest[] }>(url)).requests;
  }

  async connector(): Promise<ConnectorInfo | undefined> {
    const url = new URL("/configuration-store/api/v1/connector", this.environment.host);
    const { connectors } = await this.get<{ connectors: ConnectorInfo[] }>(url);
    return connectors.find((connector) => connector.purpose === this.purpose);
  }

  async sessions(): Promise<SessionInfo[]> {
    return (await this.get<{ sessions: SessionInfo[] }>(this.connectorUrl("/session"))).sessions;
  }

  private connectorUrl(path: string): URL {
    return new URL(
      `/configuration-store/api/v1/connector/${encodeURIComponent(this.purpose)}${path}`,
      this.environment.host,
    );
  }

  private async get<T>(url: URL): Promise<T> {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${await this.token()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`GET ${url.pathname}${url.search} returned HTTP ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private async token(): Promise<string> {
    this.accessToken ??= await generateAccessToken({
      host: this.environment.host,
      clientId: this.environment.clientId,
      clientSecret: this.environment.clientSecret,
    });
    return this.accessToken;
  }
}
