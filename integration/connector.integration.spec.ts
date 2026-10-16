import { assert, assertEquals, assertMatch } from "@std/assert";
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
  waitUntilReady?: boolean;
};

function connectorConfig(target: StubTarget, path = "api"): string {
  return `
connection:
  purpose: integration
  heartbeatIntervalSeconds: 1
logging:
  level: debug
forwarding:
  - target: '^${escapeRegExp(target.url)}/${path}(?:[/?].*)?$'
    methods: [GET, POST]
    request:
      auth:
        type: bearer
        token: "{{ env.TARGET_API_TOKEN }}"
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
  test: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const engine = StubAiProcessEngine.start({ clientId, clientSecret });
  const target = StubTarget.start(options.target);
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
    },
    config: (options.config ?? connectorConfig)(target),
  });
  try {
    if (options.waitUntilReady ?? true) await connector.waitUntilReady();
    await test({ engine, target, connector });
  } catch (error) {
    const { output } = await connector.stop("SIGKILL");
    throw new Error(`${error}\n--- Cloud Connector output ---\n${output}`, {
      cause: error,
    });
  } finally {
    await connector.close();
    await engine.close();
    await target.close();
  }
}

Deno.test("connects with client credentials and reports readiness", async () => {
  await withConnector({}, async ({ engine, connector }) => {
    const connection = await engine.connection(0);

    assertEquals(engine.tokenRequests, [{
      grantType: "client_credentials",
      clientId,
      clientSecret,
    }]);
    assertEquals(connection.purpose, "integration");
    assertEquals(connection.authorization, `Bearer ${engine.accessToken}`);

    const ready = await connector.ready();
    assertEquals(ready.status, 200);
    assertEquals(ready.body.status, "ready");
    assertEquals(ready.body.connectionState, "open");
  });
});

Deno.test("forwards an allowed request and returns the target response", async () => {
  await withConnector({
    target: () =>
      new Response('{"tickets":[1,2]}', {
        status: 201,
        headers: { "content-type": "application/json", "x-internal": "hidden" },
      }),
  }, async ({ engine, target }) => {
    const connection = await engine.connection(0);

    const frame = await connection.request({
      method: "POST",
      url: `${target.url}/api/tickets?state=open`,
      headers: {
        "content-type": ["application/json"],
        authorization: ["Bearer caller-credential"],
        cookie: ["session=caller"],
      },
      body: '{"title":"Printer broken"}',
    }, "request-1");

    assertEquals(frame.error, undefined);
    assertEquals(frame.response?.statusCode, 201);
    assertEquals(frame.response?.body, '{"tickets":[1,2]}');
    assertEquals(frame.response?.headers?.["content-type"], [
      "application/json",
    ]);
    assertEquals(frame.response?.headers?.["x-internal"], undefined);

    assertEquals(target.requests.length, 1);
    const [forwarded] = target.requests;
    assertEquals(forwarded.method, "POST");
    assertEquals(forwarded.url.pathname, "/api/tickets");
    assertEquals(forwarded.url.search, "?state=open");
    assertEquals(forwarded.body, '{"title":"Printer broken"}');
    assertEquals(forwarded.headers.get("content-type"), "application/json");
    assertEquals(
      forwarded.headers.get("authorization"),
      `Bearer ${targetToken}`,
    );
    assertEquals(forwarded.headers.get("cookie"), null);
    assertEquals(forwarded.headers.get("x-request-id"), "request-1");
  });
});

Deno.test("serves concurrent requests over one connection", async () => {
  await withConnector({
    target: ({ url }) => new Response(url.searchParams.get("n")),
  }, async ({ engine, target }) => {
    const connection = await engine.connection(0);

    const frames = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        connection.request({
          method: "GET",
          url: `${target.url}/api/echo?n=${n}`,
        })
      ),
    );

    assertEquals(
      frames.map((frame) => frame.response?.body),
      ["1", "2", "3", "4", "5"],
    );
  });
});

Deno.test("denies URLs and methods outside the forwarding policy", async () => {
  await withConnector({}, async ({ engine, target }) => {
    const connection = await engine.connection(0);

    const unmatched = await connection.request({
      method: "GET",
      url: `${target.url}/admin`,
    });
    assertEquals(unmatched.response, undefined);
    assertEquals(unmatched.error?.code, "OUTBOUND_URL_NOT_ALLOWED");

    const otherHost = await connection.request({
      method: "GET",
      url: "http://localhost:1/api/tickets",
    });
    assertEquals(otherHost.error?.code, "OUTBOUND_URL_NOT_ALLOWED");

    const method = await connection.request({
      method: "DELETE",
      url: `${target.url}/api/tickets/1`,
    });
    assertEquals(method.error?.code, "METHOD_NOT_ALLOWED");

    assertEquals(target.requests.length, 0);
  });
});

Deno.test("denies redirects that leave the forwarding policy", async () => {
  await withConnector({
    target: ({ url }) =>
      url.pathname === "/api/moved"
        ? new Response(null, {
          status: 302,
          headers: { location: "/internal/secret" },
        })
        : new Response("secret"),
  }, async ({ engine, target }) => {
    const connection = await engine.connection(0);

    const frame = await connection.request({
      method: "GET",
      url: `${target.url}/api/moved`,
    });

    assertEquals(frame.error?.code, "OUTBOUND_URL_NOT_ALLOWED");
    assertEquals(target.requests.map((request) => request.url.pathname), [
      "/api/moved",
    ]);
  });
});

Deno.test("reports unreachable targets as protocol errors", async () => {
  await withConnector({}, async ({ engine, target }) => {
    const connection = await engine.connection(0);
    const url = `${target.url}/api/tickets`;
    await target.close();

    const frame = await connection.request({ method: "GET", url });

    assertEquals(frame.error?.code, "TARGET_REQUEST_ERROR");
  });
});

Deno.test("answers heartbeats and sends its own", async () => {
  await withConnector({}, async ({ engine }) => {
    const connection = await engine.connection(0);
    const heartbeat = await connection.waitForFrame(
      (frame) => frame.type === "heartbeat",
      "connector heartbeat",
    );
    assertEquals(typeof heartbeat.sentAt, "string");

    const before = connection.frames.length;
    connection.send(JSON.stringify({ type: "heartbeat" }));
    await connection.waitForFrame(
      (frame) =>
        frame.type === "heartbeat" &&
        connection.frames.indexOf(frame) >= before,
      "heartbeat answer",
    );
  });
});

Deno.test("ignores invalid frames and keeps serving", async () => {
  await withConnector({}, async ({ engine, target }) => {
    const connection = await engine.connection(0);

    connection.send("not json");
    connection.send(JSON.stringify({ type: "request", requestId: "broken" }));
    connection.send(JSON.stringify({ type: "unknown", requestId: "x" }));

    const frame = await connection.request({
      method: "GET",
      url: `${target.url}/api/tickets`,
    });
    assertEquals(frame.response?.statusCode, 200);
    assertEquals(
      connection.frames.filter((received) =>
        received.requestId === "broken" || received.requestId === "x"
      ),
      [],
    );
    assertEquals(target.requests.length, 1);
    assert(connection.isOpen);
    assertEquals(engine.connections.length, 1);
  });
});

Deno.test("reconnects with a fresh token after the engine closes the connection", async () => {
  await withConnector({}, async ({ engine, target, connector }) => {
    const first = await engine.connection(0);
    first.close();
    await first.closed;

    const second = await engine.connection(1);
    assertEquals(engine.tokenRequests.length, 2);
    assertEquals(second.authorization, `Bearer ${engine.accessToken}`);

    const frame = await second.request({
      method: "GET",
      url: `${target.url}/api/tickets`,
    });
    assertEquals(frame.response?.statusCode, 200);
    await connector.waitUntilReady();
  });
});

Deno.test("hot-reloads forwarding rules and keeps the last valid configuration", async () => {
  await withConnector({}, async ({ engine, target, connector }) => {
    const connection = await engine.connection(0);
    const request = (path: string) =>
      connection.request({ method: "GET", url: `${target.url}/${path}` });

    assertEquals(
      (await request("v2/tickets")).error?.code,
      "OUTBOUND_URL_NOT_ALLOWED",
    );

    await connector.writeConfig(connectorConfig(target, "v2"));
    await waitForReload(connector, true);
    assertEquals((await request("v2/tickets")).response?.statusCode, 200);
    assertEquals(
      (await request("api/tickets")).error?.code,
      "OUTBOUND_URL_NOT_ALLOWED",
    );

    await connector.writeConfig("forwarding: []\n");
    await waitForReload(connector, false);
    assertEquals((await request("v2/tickets")).response?.statusCode, 200);

    assertEquals(engine.connections.length, 1);
    assert(connection.isOpen);
  });
});

Deno.test({
  name: "drains in-flight requests and exits cleanly on SIGTERM",
  // Windows cannot deliver SIGTERM to a child process.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    let releaseTarget!: () => void;
    const targetReleased = new Promise<void>((resolve) => {
      releaseTarget = resolve;
    });
    await withConnector({
      target: async () => {
        await targetReleased;
        return new Response("finished");
      },
    }, async ({ engine, target, connector }) => {
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

      assertEquals((await response).response?.body, "finished");
      await connection.closed;
      assertEquals((await exit).code, 0);
    });
  },
});

Deno.test("exits with EX_CONFIG for an invalid configuration", async () => {
  await withConnector({
    config: () => "connection:\n  purpose: integration\nforwarding: []\n",
    waitUntilReady: false,
  }, async ({ engine, connector }) => {
    const { code, output } = await connector.exited;

    assertEquals(code, 78);
    assertMatch(
      output,
      /FATAL: invalid configuration: .*forwarding must be a non-empty array of rules/,
    );
    assertEquals(engine.tokenRequests.length, 0);
  });
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
