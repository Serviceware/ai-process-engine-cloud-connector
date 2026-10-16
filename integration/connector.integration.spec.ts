import { once } from "node:events";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { expect, test } from "vitest";
import { ConnectorProcess } from "./connector-process.ts";
import { StubAiProcessEngine } from "./stub-ai-process-engine.ts";
import { StubTarget, type TargetHandler } from "./stub-target.ts";
import { waitFor } from "./wait.ts";

const clientId = "integration-client";
const clientSecret = "integration-secret";
const targetToken = "integration-target-token";

type Fixture = {
  engine: StubAiProcessEngine;
  target: StubTarget;
  connector: ConnectorProcess;
};

type FixtureOptions = {
  config?: (target: StubTarget) => string;
  target?: TargetHandler;
  env?: Record<string, string>;
  waitUntilReady?: boolean;
};

type ConfigOptions = {
  path?: string;
  heartbeatIntervalSeconds?: number;
  auth?: boolean;
};

function connectorConfig(
  target: StubTarget,
  {
    path = "api",
    heartbeatIntervalSeconds = 1,
    auth = true,
  }: ConfigOptions = {},
): string {
  const authConfig = auth
    ? `
      auth:
        type: bearer
        token: "{{ env.TARGET_API_TOKEN }}"`
    : "";
  return `
connection:
  purpose: integration
  heartbeatIntervalSeconds: ${heartbeatIntervalSeconds}
logging:
  level: debug
forwarding:
  - target: '^${escapeRegExp(target.url)}/${path}(?:[/?].*)?$'
    methods: [GET, POST]
    request:${authConfig}
      headers:
        add:
          x-request-id: "{{ context.requestId }}"
    response:
      headers:
        remove:
          - x-internal
`;
}

async function withConnector(
  options: FixtureOptions,
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const engine = await StubAiProcessEngine.start({ clientId, clientSecret });
  try {
    const target = await StubTarget.start(options.target);
    try {
      const connector = await ConnectorProcess.start({
        env: {
          CLOUD_CONNECTOR_HOST: engine.url,
          CLOUD_CONNECTOR_CLIENT_ID: clientId,
          CLOUD_CONNECTOR_CLIENT_SECRET: clientSecret,
          CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "0",
          CLOUD_CONNECTOR_RECONNECT_INITIAL_SECONDS: "1",
          CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS: "1",
          CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO: "0",
          CLOUD_CONNECTOR_DRAIN_TIMEOUT_SECONDS: "5",
          TARGET_API_TOKEN: targetToken,
          ...options.env,
        },
        config: (options.config ?? connectorConfig)(target),
      });
      try {
        if (options.waitUntilReady ?? true) await connector.waitUntilReady();
        await run({ engine, target, connector });
      } catch (error) {
        const { output } = await connector.stop("SIGKILL");
        throw new Error(`${error}\n--- Cloud Connector output ---\n${output}`, {
          cause: error,
        });
      } finally {
        await connector.close();
      }
    } finally {
      await target.close();
    }
  } finally {
    await engine.close();
  }
}

test("connects with client credentials and reports readiness", async () => {
  await withConnector({}, async ({ engine, connector }) => {
    const connection = await engine.connection(0);

    expect(engine.tokenRequests).toStrictEqual([
      {
        grantType: "client_credentials",
        clientId,
        clientSecret,
      },
    ]);
    expect(connection.purpose).toStrictEqual("integration");
    expect(engine.issuedTokens.length).toStrictEqual(1);
    expect(connection.authorization).toStrictEqual(
      `Bearer ${engine.issuedTokens[0]}`,
    );

    const ready = await connector.ready();
    expect(ready.status).toStrictEqual(200);
    expect(ready.body.status).toStrictEqual("ready");
    expect(ready.body.connectionState).toStrictEqual("open");
  });
});

test("forwards an allowed request and returns the target response", async () => {
  await withConnector(
    {
      target: () =>
        new Response('{"tickets":[1,2]}', {
          status: 201,
          headers: {
            "content-type": "application/json",
            "x-internal": "hidden",
          },
        }),
    },
    async ({ engine, target }) => {
      const connection = await engine.connection(0);

      const frame = await connection.request(
        {
          method: "POST",
          url: `${target.url}/api/tickets?state=open`,
          headers: {
            "content-type": ["application/json"],
            authorization: ["Bearer caller-credential"],
            cookie: ["session=caller"],
          },
          body: '{"title":"Printer broken"}',
        },
        "request-1",
      );

      expect(frame.error).toStrictEqual(undefined);
      expect(frame.response?.statusCode).toStrictEqual(201);
      expect(frame.response?.body).toStrictEqual('{"tickets":[1,2]}');
      expect(frame.response?.headers?.["content-type"]).toStrictEqual([
        "application/json",
      ]);
      expect(frame.response?.headers?.["x-internal"]).toStrictEqual(undefined);

      expect(target.requests.length).toStrictEqual(1);
      const [forwarded] = target.requests;
      expect(forwarded.method).toStrictEqual("POST");
      expect(forwarded.url.pathname).toStrictEqual("/api/tickets");
      expect(forwarded.url.search).toStrictEqual("?state=open");
      expect(forwarded.body).toStrictEqual('{"title":"Printer broken"}');
      expect(forwarded.headers.get("content-type")).toStrictEqual(
        "application/json",
      );
      expect(forwarded.headers.get("authorization")).toStrictEqual(
        `Bearer ${targetToken}`,
      );
      expect(forwarded.headers.get("cookie")).toStrictEqual(null);
      expect(forwarded.headers.get("x-request-id")).toStrictEqual("request-1");
    },
  );
});

test("strips caller credentials when the rule configures no auth", async () => {
  await withConnector(
    { config: (target) => connectorConfig(target, { auth: false }) },
    async ({ engine, target }) => {
      const connection = await engine.connection(0);

      const frame = await connection.request({
        method: "GET",
        url: `${target.url}/api/tickets`,
        headers: {
          authorization: ["Bearer caller-credential"],
          cookie: ["session=caller"],
        },
      });

      expect(frame.response?.statusCode).toStrictEqual(200);
      const [forwarded] = target.requests;
      expect(forwarded.headers.get("authorization")).toStrictEqual(null);
      expect(forwarded.headers.get("cookie")).toStrictEqual(null);
    },
  );
});

test("serves concurrent requests over one connection", async () => {
  const concurrency = 5;
  let arrived = 0;
  let releaseTargets!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    releaseTargets = resolve;
  });
  await withConnector(
    {
      target: async ({ url }) => {
        arrived += 1;
        if (arrived === concurrency) releaseTargets();
        await allArrived;
        return new Response(url.searchParams.get("n"));
      },
    },
    async ({ engine, target }) => {
      const connection = await engine.connection(0);

      const frames = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          connection.request({
            method: "GET",
            url: `${target.url}/api/echo?n=${n}`,
          }),
        ),
      );

      expect(frames.map((frame) => frame.response?.body)).toStrictEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
      ]);
    },
  );
});

test("denies URLs and methods outside the forwarding policy", async () => {
  await withConnector({}, async ({ engine, target }) => {
    const connection = await engine.connection(0);

    const unmatched = await connection.request({
      method: "GET",
      url: `${target.url}/admin`,
    });
    expect(unmatched.response).toStrictEqual(undefined);
    expect(unmatched.error?.code).toStrictEqual("OUTBOUND_URL_NOT_ALLOWED");

    const otherHost = await connection.request({
      method: "GET",
      url: "http://localhost:1/api/tickets",
    });
    expect(otherHost.error?.code).toStrictEqual("OUTBOUND_URL_NOT_ALLOWED");

    const method = await connection.request({
      method: "DELETE",
      url: `${target.url}/api/tickets/1`,
    });
    expect(method.error?.code).toStrictEqual("METHOD_NOT_ALLOWED");

    expect(target.requests.length).toStrictEqual(0);
  });
});

test("denies redirects that leave the forwarding policy", async () => {
  await withConnector(
    {
      target: ({ url }) =>
        url.pathname === "/api/moved"
          ? new Response(null, {
              status: 302,
              headers: { location: "/internal/secret" },
            })
          : new Response("secret"),
    },
    async ({ engine, target }) => {
      const connection = await engine.connection(0);

      const frame = await connection.request({
        method: "GET",
        url: `${target.url}/api/moved`,
      });

      expect(frame.error?.code).toStrictEqual("OUTBOUND_URL_NOT_ALLOWED");
      expect(
        target.requests.map((request) => request.url.pathname),
      ).toStrictEqual(["/api/moved"]);
    },
  );
});

test("reports unreachable targets as protocol errors", async () => {
  await withConnector({}, async ({ engine, target }) => {
    const connection = await engine.connection(0);
    const url = `${target.url}/api/tickets`;
    await target.close();

    const frame = await connection.request({ method: "GET", url });

    expect(frame.error?.code).toStrictEqual("TARGET_REQUEST_ERROR");
  });
});

test("sends periodic heartbeats", async () => {
  await withConnector({}, async ({ engine }) => {
    const connection = await engine.connection(0);
    const heartbeats = () =>
      connection.frames.filter((frame) => frame.type === "heartbeat");

    await waitFor(
      () => heartbeats().length >= 2 || undefined,
      "two connector heartbeats",
    );
    expect(typeof heartbeats()[0].sentAt).toStrictEqual("string");
  });
});

test("answers heartbeats from the engine", async () => {
  await withConnector(
    {
      config: (target) =>
        connectorConfig(target, { heartbeatIntervalSeconds: 60 }),
    },
    async ({ engine }) => {
      const connection = await engine.connection(0);
      const before = connection.frames.length;

      connection.send(JSON.stringify({ type: "heartbeat" }));

      const answer = await connection.waitForFrame(
        (frame) =>
          frame.type === "heartbeat" &&
          connection.frames.indexOf(frame) >= before,
        "heartbeat answer",
      );
      expect(typeof answer.sentAt).toStrictEqual("string");
    },
  );
});

test("reports not ready while the engine connection is down", async () => {
  await withConnector({}, async ({ engine, connector }) => {
    const connection = await engine.connection(0);
    engine.acceptConnections = false;
    connection.close();
    await connection.closed;

    const notReady = await waitFor(async () => {
      const ready = await connector.ready();
      return ready.status === 503 ? ready : undefined;
    }, "readiness 503");
    expect(notReady.body.status).toStrictEqual("not_ready");

    engine.acceptConnections = true;
    await connector.waitUntilReady();
  });
});

test("ignores invalid frames and keeps serving", async () => {
  await withConnector({}, async ({ engine, target }) => {
    const connection = await engine.connection(0);

    connection.send("not json");
    connection.send(JSON.stringify({ type: "request", requestId: "broken" }));
    connection.send(JSON.stringify({ type: "unknown", requestId: "x" }));

    const frame = await connection.request({
      method: "GET",
      url: `${target.url}/api/tickets`,
    });
    expect(frame.response?.statusCode).toStrictEqual(200);
    expect(
      connection.frames.filter(
        (received) =>
          received.requestId === "broken" || received.requestId === "x",
      ),
    ).toStrictEqual([]);
    expect(target.requests.length).toStrictEqual(1);
    expect(connection.isOpen).toBeTruthy();
    expect(engine.connections.length).toStrictEqual(1);
  });
});

test("reconnects with a fresh token after the engine closes the connection", async () => {
  await withConnector({}, async ({ engine, target, connector }) => {
    const first = await engine.connection(0);
    first.close();
    await first.closed;

    const second = await engine.connection(1);
    expect(engine.tokenRequests.length).toStrictEqual(2);
    expect(first.authorization).toStrictEqual(
      `Bearer ${engine.issuedTokens[0]}`,
    );
    expect(second.authorization).toStrictEqual(
      `Bearer ${engine.issuedTokens[1]}`,
    );

    const frame = await second.request({
      method: "GET",
      url: `${target.url}/api/tickets`,
    });
    expect(frame.response?.statusCode).toStrictEqual(200);
    await connector.waitUntilReady();
  });
});

test("hot-reloads forwarding rules and keeps the last valid configuration", async () => {
  await withConnector({}, async ({ engine, target, connector }) => {
    const connection = await engine.connection(0);
    const request = (path: string) =>
      connection.request({ method: "GET", url: `${target.url}/${path}` });

    expect((await request("v2/tickets")).error?.code).toStrictEqual(
      "OUTBOUND_URL_NOT_ALLOWED",
    );

    await connector.writeConfig(connectorConfig(target, { path: "v2" }));
    await waitForReload(connector, true);
    expect((await request("v2/tickets")).response?.statusCode).toStrictEqual(
      200,
    );
    expect((await request("api/tickets")).error?.code).toStrictEqual(
      "OUTBOUND_URL_NOT_ALLOWED",
    );

    await connector.writeConfig("forwarding: []\n");
    await waitForReload(connector, false);
    expect((await request("v2/tickets")).response?.statusCode).toStrictEqual(
      200,
    );

    expect(engine.connections.length).toStrictEqual(1);
    expect(connection.isOpen).toBeTruthy();
  });
});

// Windows cannot deliver SIGTERM to a child process.
test.skipIf(process.platform === "win32")(
  "drains in-flight requests and exits cleanly on SIGTERM",
  async () => {
    let releaseTarget!: () => void;
    const targetReleased = new Promise<void>((resolve) => {
      releaseTarget = resolve;
    });
    await withConnector(
      {
        target: async () => {
          await targetReleased;
          return new Response("finished");
        },
      },
      async ({ engine, target, connector }) => {
        const connection = await engine.connection(0);
        const response = connection.request({
          method: "GET",
          url: `${target.url}/api/slow`,
        });
        await waitFor(
          () => target.requests.length > 0 || undefined,
          "slow target request",
        );

        const exit = connector.stop("SIGTERM");
        setTimeout(releaseTarget, 500);

        expect((await response).response?.body).toStrictEqual("finished");
        await connection.closed;
        expect((await exit).code).toStrictEqual(0);
      },
    );
  },
);

test("exits with EX_CONFIG for an invalid configuration", async () => {
  await withConnector(
    {
      config: () => "connection:\n  purpose: integration\nforwarding: []\n",
      waitUntilReady: false,
    },
    async ({ engine, connector }) => {
      const { code, output } = await connector.waitForExit();

      expect(code).toStrictEqual(78);
      expect(output).toMatch(
        /FATAL: invalid configuration: .*forwarding must be a non-empty array of rules/,
      );
      expect(engine.tokenRequests.length).toStrictEqual(0);
    },
  );
});

// Windows cannot deliver SIGINT to a child process.
test.skipIf(process.platform === "win32")(
  "exits cleanly on SIGINT",
  async () => {
    await withConnector({}, async ({ engine, connector }) => {
      const connection = await engine.connection(0);

      const { code } = await connector.stop("SIGINT");

      expect(code).toStrictEqual(0);
      await connection.closed;
    });
  },
);

test("exits with EX_OSERR when the probe port is taken", async () => {
  const blocker = createServer();
  blocker.listen(8080, "0.0.0.0");
  await once(blocker, "listening");
  try {
    await withConnector({ waitUntilReady: false }, async ({ connector }) => {
      const { code, output } = await connector.waitForExit();

      expect(code).toStrictEqual(71);
      expect(output).toMatch(/FATAL: cannot bind HTTP server/);
    });
  } finally {
    blocker.close();
    await once(blocker, "close");
  }
});

async function waitForReload(
  connector: ConnectorProcess,
  succeeded: boolean,
): Promise<void> {
  await waitFor(async () => {
    const { body } = await connector.ready();
    const reload = body.configReload as { succeeded: boolean | null };
    return reload.succeeded === succeeded || undefined;
  }, `configuration reload with succeeded=${succeeded}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Windows cannot deliver SIGTERM to a child process.
test.skipIf(process.platform === "win32")(
  "exits on SIGTERM when the engine never answers the close frame",
  async () => {
    await withConnector({}, async ({ engine, connector }) => {
      const connection = await engine.connection(0);
      connection.stopReading();

      const { code } = await connector.stop("SIGTERM");

      expect(code).toStrictEqual(0);
    });
  },
);

test("sends control-plane requests through HTTP_PROXY", async () => {
  const proxied: string[] = [];
  const proxy = createHttpServer((request, response) => {
    proxied.push(`${request.method} ${request.url}`);
    const upstream = httpRequest(
      request.url ?? "",
      { method: request.method, headers: request.headers },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    request.pipe(upstream);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const { port } = proxy.address() as AddressInfo;
    await withConnector(
      {
        env: { HTTP_PROXY: `http://127.0.0.1:${port}` },
        waitUntilReady: false,
      },
      async ({ engine }) => {
        await waitFor(
          () => engine.tokenRequests.length > 0 || undefined,
          "token request through the proxy",
        );

        expect(proxied).toContain(`GET ${engine.url}/.well-known`);
      },
    );
  } finally {
    proxy.closeAllConnections();
    proxy.close();
  }
});
