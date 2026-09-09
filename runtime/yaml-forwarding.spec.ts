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
  env: {
    API_TOKEN: "secret-token",
    TENANT_ID: "tenant-123",
  },
};

function configFor(forwardingYaml: string): ConnectorConfig {
  const indented = forwardingYaml.trim().split("\n")
    .map((line) => "  " + line)
    .join("\n");
  return combineConfig(
    environment,
    parseVolumeConfig(
      "connection:\n" +
        "  websocketUrl: wss://cloud.example/connector/ws\n" +
        "forwarding:\n" +
        indented +
        "\n",
    ),
  );
}

Deno.test("YamlForwardingExecutor forwards every path to the configured target", async () => {
  const calls: Request[] = [];
  const config = configFor(
    'target: "{{ env.API_URL }}"\n' +
      "outboundUrlAllowlist:\n" +
      '  - "^https://internal[.]example(?:/|$)"\n' +
      "methods: [POST]\n" +
      "request:\n" +
      "  headers:\n" +
      "    set:\n" +
      '      authorization: "Bearer {{ env.API_TOKEN }}"\n' +
      "  pathPrefix: /api\n" +
      "response:\n" +
      "  headers:\n" +
      "    remove: [server]",
  );
  const executor = await createYamlForwardingExecutor({
    config,
    configPath: "/config/cloud-connector.yml",
    env: {
      API_URL: "https://internal.example",
      API_TOKEN: "secret",
    },
    logger: silentLogger,
    nextFetch: ((input) => {
      calls.push(input instanceof Request ? input : new Request(input));
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
      url: "https://attacker.invalid/orders?state=open",
      headers: { host: ["attacker.invalid"], "content-type": ["text/plain"] },
      body: "payload",
    },
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://internal.example/api/orders?state=open");
  assertEquals(calls[0].headers.get("authorization"), "Bearer secret");
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

Deno.test("YamlForwardingExecutor keeps default-deny outbound policy", async () => {
  let calls = 0;
  const executor = await createYamlForwardingExecutor({
    config: configFor("target: https://internal.example"),
    configPath: "/config/cloud-connector.yml",
    logger: silentLogger,
    nextFetch: (() => {
      calls += 1;
      return Promise.resolve(new Response("unexpected"));
    }) as Fetcher,
  });

  await assertRejects(
    () =>
      executor.execute({
        type: "request",
        requestId: "request-1",
        request: { method: "GET", url: "/orders" },
      }),
    RuntimeError,
    "forwarding.outboundUrlAllowlist",
  );
  assertEquals(calls, 0);
});

Deno.test("YamlForwardingExecutor enforces configured methods", async () => {
  const executor = await createYamlForwardingExecutor({
    config: configFor(
      "target: https://internal.example\n" +
        "methods: [GET]",
    ),
    configPath: "/config/cloud-connector.yml",
    logger: silentLogger,
  });
  const error = await assertRejects(
    () =>
      executor.execute({
        type: "request",
        requestId: "request-1",
        request: { method: "DELETE", url: "/orders/1" },
      }),
    RuntimeError,
  );
  assertEquals(error.code, "METHOD_NOT_ALLOWED");
});

Deno.test("YamlForwardingExecutor resolves and validates target secrets before activation", async () => {
  await assertRejects(
    () =>
      createYamlForwardingExecutor({
        config: configFor('target: "{{ env.MISSING_TARGET }}"'),
        configPath: "/config/cloud-connector.yml",
        env: {},
        logger: silentLogger,
      }),
    RuntimeError,
    "empty after environment interpolation",
  );
});

Deno.test("maintained templates contain valid complete connector YAML", async () => {
  const templates: Array<{ path: string; env: Record<string, string> }> = [
    {
      path: new URL(
        "../templates/starter/config/cloud-connector.yml",
        import.meta.url,
      )
        .pathname,
      env: { INTERNAL_API_TOKEN: "secret" },
    },
    {
      path: new URL(
        "../templates/examples/ticketing-yaml/config/cloud-connector.yml",
        import.meta.url,
      ).pathname,
      env: { TICKET_API_TOKEN: "secret" },
    },
  ];

  for (const template of templates) {
    const config = combineConfig(
      environment,
      await loadVolumeConfig(template.path),
    );
    await createYamlForwardingExecutor({
      config,
      configPath: template.path,
      env: template.env,
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

Deno.test("YAML request forwarding updates only headers and path prefix", () => {
  const config: YamlRequestForwardingConfig = {
    headers: {
      set: { authorization: "Bearer {{ env.API_TOKEN }}" },
      add: { "x-tenant-id": "{{ env.TENANT_ID }}" },
      remove: ["x-internal"],
    },
    pathPrefix: "/v2",
  };
  assertEquals(
    applyYamlRequestForwardingConfig(
      config,
      {
        method: "GET",
        url: "/users?active=true",
        headers: { "x-internal": ["secret"] },
      },
      baseContext,
    ),
    {
      method: "GET",
      url: "/v2/users?active=true",
      headers: {
        authorization: ["Bearer secret-token"],
        "x-tenant-id": ["tenant-123"],
      },
    },
  );
});

Deno.test("YAML response forwarding changes headers only", () => {
  const config: YamlResponseForwardingConfig = {
    headers: { add: { "x-request-id": "{{ context.requestId }}" } },
  };
  assertEquals(
    applyYamlResponseForwardingConfig(
      config,
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

Deno.test("YAML rejects removed customization capabilities", () => {
  const removedCapabilities = [
    "request:\n  body:\n    set: changed",
    'request:\n  reject:\n    if: request.method == "GET"',
    "request:\n  url:\n    rewrite: /other",
    "response:\n  body:\n    set: changed",
    "response:\n  statusCode:\n    set: 201",
    'request:\n  headers:\n    set:\n      x-path: "{{ request.url }}"',
  ];

  for (const capability of removedCapabilities) {
    const error = assertThrows(
      () =>
        configFor(
          "target: https://internal.example\n" +
            capability,
        ),
      RuntimeError,
    );
    assertEquals(error.code, "CONFIG_ERROR");
  }
});

Deno.test("YAML rejects unsafe path prefixes", () => {
  for (
    const prefix of [
      "relative",
      "//other-host",
      "/api?override=true",
      "/api#fragment",
      "/{{ env.PREFIX }}",
    ]
  ) {
    assertThrows(
      () =>
        configFor(
          "target: https://internal.example\n" +
            "request:\n" +
            '  pathPrefix: "' + prefix + '"',
        ),
      RuntimeError,
      "forwarding.request.pathPrefix must be an absolute path",
    );
  }
});
