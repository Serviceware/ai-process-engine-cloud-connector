import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  combineConfig,
  type ConnectorConfig,
  loadEnvironmentConfig,
  loadVolumeConfig,
  parseVolumeConfig,
} from "./config.ts";
import { createLogger } from "./logger.ts";
import type { Fetcher } from "./outbound-url-policy.ts";
import { RuntimeError } from "./runtime-error.ts";
import {
  applyYamlRequestForwardingConfig,
  applyYamlResponseForwardingConfig,
  createYamlForwardingExecutor,
  interpolate,
  mergeForwardingConfigs,
  type YamlRequestForwardingConfig,
  type YamlResponseForwardingConfig,
  type YamlValueContext,
} from "./yaml-forwarding.ts";

const silentLogger = createLogger("error", {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

const environment = loadEnvironmentConfig({
  CLOUD_CONNECTOR_HOST: "https://cloud.example",
  CLOUD_CONNECTOR_CLIENT_ID: "client-id",
  CLOUD_CONNECTOR_CLIENT_SECRET: "client-secret",
});

const baseContext: YamlValueContext = {
  requestId: "test-request-id",
  startedAt: "2024-01-01T00:00:00.000Z",
  env: { API_TOKEN: "secret-token", TENANT_ID: "tenant-123" },
};

function configFor(forwardingYaml: string): ConnectorConfig {
  const indented = forwardingYaml.trim().split("\n")
    .map((line) => "  " + line)
    .join("\n");
  return combineConfig(
    environment,
    parseVolumeConfig("connection: {}\nforwarding:\n" + indented + "\n"),
  );
}

Deno.test("YamlForwardingExecutor matches the complete URL and merges ordered rules", async () => {
  const calls: Request[] = [];
  const config = configFor(`
- target: ^https://internal[.]example/
  methods: []
  timeout: 5000
  request:
    headers:
      set:
        x-policy: general
        x-overridden: first
    pathPrefix: /api
  response:
    headers:
      remove: [server]
- target: ^https://internal[.]example/orders
  methods: [POST]
  request:
    headers:
      set:
        x-overridden: second
      add:
        x-request-id: "{{ context.requestId }}"
    auth:
      type: bearer
      token: "{{ env.API_TOKEN }}"
`);
  const executor = await createYamlForwardingExecutor({
    config,
    configPath: "/config/cloud-connector.yml",
    env: { API_TOKEN: "secret" },
    logger: silentLogger,
    nextFetch: ((input) => {
      const request = input instanceof Request ? input : new Request(input);
      calls.push(request);
      return Promise.resolve(
        new Response("forwarded", {
          status: 201,
          headers: { server: "private", "x-upstream": "ok" },
        }),
      );
    }) as Fetcher,
  });

  const response = await executor.execute({
    type: "request",
    requestId: "request-1",
    request: {
      method: "POST",
      url: "https://internal.example/orders?state=open",
      headers: { host: ["internal.example"], "content-type": ["text/plain"] },
      body: "payload",
    },
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://internal.example/api/orders?state=open");
  assertEquals(calls[0].headers.get("authorization"), "Bearer secret");
  assertEquals(calls[0].headers.get("x-policy"), "general");
  assertEquals(calls[0].headers.get("x-overridden"), "second");
  assertEquals(calls[0].headers.get("x-request-id"), "request-1");
  assertEquals(calls[0].headers.get("host"), null);
  assertEquals(await calls[0].text(), "payload");
  assertEquals(response, {
    statusCode: 201,
    headers: {
      "content-type": ["text/plain;charset=UTF-8"],
      "x-upstream": ["ok"],
    },
    body: "forwarded",
  });
});

Deno.test("YamlForwardingExecutor denies unmatched URLs and explicit empty methods", async () => {
  const executor = await createYamlForwardingExecutor({
    config: configFor("- target: ^https://internal[.]example/\n  methods: []"),
    configPath: "/config/cloud-connector.yml",
    logger: silentLogger,
  });
  const unmatched = await assertRejects(
    () =>
      executor.execute({
        type: "request",
        requestId: "1",
        request: { method: "GET", url: "https://blocked.example/orders" },
      }),
    RuntimeError,
  );
  assertEquals(unmatched.code, "OUTBOUND_URL_NOT_ALLOWED");
  const method = await assertRejects(
    () =>
      executor.execute({
        type: "request",
        requestId: "2",
        request: { method: "GET", url: "https://internal.example/orders" },
      }),
    RuntimeError,
  );
  assertEquals(method.code, "METHOD_NOT_ALLOWED");
});

Deno.test("YamlForwardingExecutor obtains and caches OAuth2 client-credentials tokens", async () => {
  const calls: Request[] = [];
  const executor = await createYamlForwardingExecutor({
    config: configFor(`
- target: ^https://internal[.]example/
  request:
    auth:
      type: oauth2
      issuer: https://auth.example/token
      clientId: connector
      clientSecret: "{{env:CLIENT_SECRET}}"
      scope: inventory.read
`),
    configPath: "/config/cloud-connector.yml",
    env: { CLIENT_SECRET: "secret" },
    logger: silentLogger,
    nextFetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      if (request.url === "https://auth.example/token") {
        assertEquals(
          await request.clone().text(),
          "grant_type=client_credentials&client_id=connector&client_secret=secret&scope=inventory.read",
        );
        return Response.json({ access_token: "oauth-token", expires_in: 60 });
      }
      assertEquals(request.headers.get("authorization"), "Bearer oauth-token");
      return new Response("ok");
    }) as Fetcher,
  });
  const frame = {
    type: "request" as const,
    requestId: "request-1",
    request: { method: "GET" as const, url: "https://internal.example/items" },
  };
  await executor.execute(frame);
  await executor.execute(frame);
  assertEquals(
    calls.filter((call) => call.url === "https://auth.example/token").length,
    1,
  );
});

Deno.test("mergeForwardingConfigs applies later explicit values and header entries", () => {
  assertEquals(
    mergeForwardingConfigs([
      {
        target: "first",
        methods: ["GET"],
        timeout: 1000,
        request: { headers: { set: { "x-one": "1", "x-shared": "old" } } },
      },
      {
        target: "second",
        methods: [],
        request: { headers: { set: { "X-Shared": "new" }, remove: ["x-one"] } },
      },
    ]),
    {
      target: "second",
      methods: [],
      timeout: 1000,
      request: {
        headers: { remove: ["x-one"], set: { "X-Shared": "new" } },
        pathPrefix: undefined,
        auth: undefined,
      },
    },
  );
});

Deno.test("maintained templates contain valid complete connector YAML", async () => {
  for (
    const path of [
      new URL(
        "../templates/starter/config/cloud-connector.yml",
        import.meta.url,
      ).pathname,
      new URL(
        "../templates/examples/ticketing-yaml/config/cloud-connector.yml",
        import.meta.url,
      ).pathname,
    ]
  ) {
    const config = combineConfig(environment, await loadVolumeConfig(path));
    await createYamlForwardingExecutor({
      config,
      configPath: path,
      logger: silentLogger,
    });
  }
});

Deno.test("interpolate exposes only documented declarative values", () => {
  assertEquals(
    interpolate(
      "Bearer {{ env.API_TOKEN }} / {{ context.requestId }}",
      baseContext,
    ),
    "Bearer secret-token / test-request-id",
  );
  assertEquals(interpolate("{{ env.MISSING }}", baseContext), "");
  assertEquals(interpolate("{{ request.url }}", baseContext), "");
});

Deno.test("YAML request and response transformations remain declarative", () => {
  const requestConfig: YamlRequestForwardingConfig = {
    headers: {
      set: { authorization: "Bearer {{ env.API_TOKEN }}" },
      add: { "x-tenant-id": "{{ env.TENANT_ID }}" },
      remove: ["x-internal"],
    },
    pathPrefix: "/v2",
  };
  assertEquals(
    applyYamlRequestForwardingConfig(
      requestConfig,
      {
        method: "GET",
        url: "https://internal.example/users?active=true",
        headers: { "x-internal": ["secret"] },
      },
      baseContext,
    ),
    {
      method: "GET",
      url: "https://internal.example/v2/users?active=true",
      headers: {
        authorization: ["Bearer secret-token"],
        "x-tenant-id": ["tenant-123"],
      },
    },
  );

  const responseConfig: YamlResponseForwardingConfig = {
    headers: { add: { "x-request-id": "{{ context.requestId }}" } },
  };
  assertEquals(
    applyYamlResponseForwardingConfig(
      responseConfig,
      { statusCode: 200, headers: {}, body: "original" },
      baseContext,
    ),
    {
      statusCode: 200,
      headers: { "x-request-id": ["test-request-id"] },
      body: "original",
    },
  );
});

Deno.test("YAML validates rules, authentication, and path prefixes", () => {
  for (
    const yaml of [
      "- target: '('",
      "- target: https://internal.example\n  request:\n    auth:\n      type: bearer",
      "- target: https://internal.example\n  request:\n    auth:\n      type: oauth2\n      issuer: relative\n      clientId: id\n      clientSecret: secret",
      "- target: https://internal.example\n  request:\n    pathPrefix: //unsafe",
      "- target: https://internal.example\n  response:\n    body:\n      set: changed",
    ]
  ) assertThrows(() => configFor(yaml), RuntimeError);
});
