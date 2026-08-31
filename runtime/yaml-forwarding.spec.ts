import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import type { Fetcher } from "./outbound-url-policy.ts";
import { RuntimeError } from "./runtime-error.ts";
import {
  applyYamlRequestTransform,
  applyYamlResponseTransform,
  createYamlForwardingExecutor,
  interpolate,
  parseYamlForwardingConfig,
  type YamlRequestTransformConfig,
  type YamlResponseTransformConfig,
  type YamlTransformContext,
} from "./yaml-forwarding.ts";

const silentLogger = createLogger("error", {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

const baseContext: YamlTransformContext = {
  requestId: "test-request-id",
  startedAt: "2024-01-01T00:00:00.000Z",
  request: {
    method: "GET",
    url: "/api/test",
    headers: { "content-type": ["application/json"] },
    body: "test-body",
  },
  env: {
    API_TOKEN: "secret-token",
    TENANT_ID: "tenant-123",
  },
};

Deno.test("parseYamlForwardingConfig requires one valid forwarding target", () => {
  assertEquals(
    parseYamlForwardingConfig(
      "target: https://internal.example\nmethods: [GET, POST]\ntimeout: 5000\n",
      "forwarding.yml",
    ),
    {
      target: "https://internal.example",
      methods: ["GET", "POST"],
      timeout: 5000,
    },
  );

  for (
    const content of [
      "{}",
      "target: ''",
      "target: /relative",
      "target: ok\nunknown: true",
    ]
  ) {
    assertThrows(
      () => parseYamlForwardingConfig(content, "forwarding.yml"),
      RuntimeError,
      "Invalid YAML forwarding config",
    );
  }
});

Deno.test("YamlForwardingExecutor forwards every path to the configured target", async () => {
  const file = await Deno.makeTempFile({ suffix: ".yml" });
  const calls: Request[] = [];
  try {
    await Deno.writeTextFile(
      file,
      `target: "{{ env.API_URL }}"
methods: [POST]
request:
  headers:
    set:
      authorization: "Bearer {{ env.API_TOKEN }}"
  url:
    prefix: /api
response:
  headers:
    remove: [server]
`,
    );
    const executor = await createYamlForwardingExecutor({
      config: loadConfig({
        CLOUD_CONNECTOR_FORWARDING_CONFIG: file,
        OUTBOUND_URL_ALLOWLIST: '["^https://internal[.]example(?:/|$)"]',
      }),
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
    assertEquals(
      calls[0].url,
      "https://internal.example/api/orders?state=open",
    );
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
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("YamlForwardingExecutor keeps default-deny outbound policy", async () => {
  const file = await Deno.makeTempFile({ suffix: ".yml" });
  let calls = 0;
  try {
    await Deno.writeTextFile(file, "target: https://internal.example\n");
    const executor = await createYamlForwardingExecutor({
      config: loadConfig({ CLOUD_CONNECTOR_FORWARDING_CONFIG: file }),
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
      "OUTBOUND_URL_ALLOWLIST",
    );
    assertEquals(calls, 0);
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("YamlForwardingExecutor enforces configured methods", async () => {
  const file = await Deno.makeTempFile({ suffix: ".yml" });
  try {
    await Deno.writeTextFile(
      file,
      "target: https://internal.example\nmethods: [GET]\n",
    );
    const executor = await createYamlForwardingExecutor({
      config: loadConfig({ CLOUD_CONNECTOR_FORWARDING_CONFIG: file }),
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
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("YamlForwardingExecutor resolves and validates target environment at startup", async () => {
  const file = await Deno.makeTempFile({ suffix: ".yml" });
  try {
    await Deno.writeTextFile(file, 'target: "{{ env.MISSING_TARGET }}"\n');
    await assertRejects(
      () =>
        createYamlForwardingExecutor({
          config: loadConfig({ CLOUD_CONNECTOR_FORWARDING_CONFIG: file }),
          env: {},
          logger: silentLogger,
        }),
      RuntimeError,
      "empty after environment interpolation",
    );
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("maintained templates contain valid YAML forwarding configuration", async () => {
  const templates: Array<{ path: string; env: Record<string, string> }> = [
    {
      path: new URL("../templates/starter/forwarding.yml", import.meta.url)
        .pathname,
      env: {
        INTERNAL_API_URL: "https://internal.example",
        INTERNAL_API_TOKEN: "secret",
      },
    },
    {
      path: new URL(
        "../templates/examples/ticketing-yaml/forwarding.yml",
        import.meta.url,
      ).pathname,
      env: {
        TICKET_API_URL: "https://tickets.example",
        TICKET_API_TOKEN: "secret",
      },
    },
  ];

  for (const template of templates) {
    await createYamlForwardingExecutor({
      config: loadConfig({ CLOUD_CONNECTOR_FORWARDING_CONFIG: template.path }),
      env: template.env,
      logger: silentLogger,
    });
  }
});

Deno.test("interpolate exposes only documented declarative values", () => {
  assertEquals(
    interpolate(
      "Bearer {{ env.API_TOKEN }} / {{ context.requestId }} / {{ request.url }}",
      baseContext,
    ),
    "Bearer secret-token / test-request-id / /api/test",
  );
  assertEquals(interpolate("{{ env.MISSING }}", baseContext), "");
});

Deno.test("YAML request transformations update headers, URL, and rejection", () => {
  const config: YamlRequestTransformConfig = {
    headers: {
      set: { authorization: "Bearer {{ env.API_TOKEN }}" },
      add: { "x-tenant-id": "{{ env.TENANT_ID }}" },
      remove: ["x-internal"],
    },
    url: { removePrefix: "/api", prefix: "/v2" },
  };
  assertEquals(
    applyYamlRequestTransform(
      config,
      {
        method: "GET",
        url: "/api/users",
        headers: { "x-internal": ["secret"] },
      },
      baseContext,
    ),
    {
      method: "GET",
      url: "/v2/users",
      headers: {
        authorization: ["Bearer secret-token"],
        "x-tenant-id": ["tenant-123"],
      },
    },
  );

  assertThrows(
    () =>
      applyYamlRequestTransform(
        { reject: { if: 'request.url contains "/admin"', message: "denied" } },
        { method: "GET", url: "/admin" },
        baseContext,
      ),
    RuntimeError,
    "denied",
  );
});

Deno.test("YAML response transformations remain declarative", () => {
  const config: YamlResponseTransformConfig = {
    headers: { add: { "x-request-id": "{{ context.requestId }}" } },
    body: { set: "request={{ context.requestId }}" },
    statusCode: { set: 202 },
  };
  assertEquals(
    applyYamlResponseTransform(
      config,
      { statusCode: 200, headers: {}, body: "original" },
      baseContext,
    ),
    {
      statusCode: 202,
      headers: { "x-request-id": ["test-request-id"] },
      body: "request=test-request-id",
    },
  );
});
