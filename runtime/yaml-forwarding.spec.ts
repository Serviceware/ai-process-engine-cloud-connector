import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
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
  createOAuthTokenCache,
  createYamlForwardingExecutor,
  effectiveTimeout,
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
  const indented = forwardingYaml
    .trim()
    .split("\n")
    .map((line) => "  " + line)
    .join("\n");
  return combineConfig(
    environment,
    parseVolumeConfig("connection: {}\nforwarding:\n" + indented + "\n"),
  );
}

test("YamlForwardingExecutor matches the complete URL and merges ordered rules", async () => {
  const calls: Request[] = [];
  const config = configFor(`
- target: ^https://internal[.]example/.*$
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
- target: ^https://internal[.]example/orders(?:[/?].*)?$
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

  expect(calls.length).toStrictEqual(1);
  expect(calls[0].url).toStrictEqual(
    "https://internal.example/api/orders?state=open",
  );
  expect(calls[0].headers.get("authorization")).toStrictEqual("Bearer secret");
  expect(calls[0].headers.get("x-policy")).toStrictEqual("general");
  expect(calls[0].headers.get("x-overridden")).toStrictEqual("second");
  expect(calls[0].headers.get("x-request-id")).toStrictEqual("request-1");
  expect(calls[0].headers.get("host")).toStrictEqual(null);
  expect(await calls[0].text()).toStrictEqual("payload");
  expect(response).toStrictEqual({
    statusCode: 201,
    headers: {
      "content-type": ["text/plain;charset=UTF-8"],
      "x-upstream": ["ok"],
    },
    body: "forwarded",
  });
});

test("YamlForwardingExecutor denies unmatched URLs and explicit empty methods", async () => {
  const executor = await createYamlForwardingExecutor({
    config: configFor(
      "- target: ^https://internal[.]example/.*$\n  methods: []",
    ),
    configPath: "/config/cloud-connector.yml",
    logger: silentLogger,
  });
  await expect(
    executor.execute({
      type: "request",
      requestId: "1",
      request: { method: "GET", url: "https://blocked.example/orders" },
    }),
  ).rejects.toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      code: "OUTBOUND_URL_NOT_ALLOWED",
    }),
  );
  await expect(
    executor.execute({
      type: "request",
      requestId: "2",
      request: { method: "GET", url: "https://internal.example/orders" },
    }),
  ).rejects.toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      code: "METHOD_NOT_ALLOWED",
    }),
  );
});

test("YamlForwardingExecutor obtains and caches OAuth2 client-credentials tokens", async () => {
  const calls: Request[] = [];
  const executor = await createYamlForwardingExecutor({
    config: configFor(`
- target: ^https://internal[.]example/.*$
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
        expect(await request.clone().text()).toStrictEqual(
          "grant_type=client_credentials&client_id=connector&client_secret=secret&scope=inventory.read",
        );
        return Response.json({ access_token: "oauth-token", expires_in: 60 });
      }
      expect(request.headers.get("authorization")).toStrictEqual(
        "Bearer oauth-token",
      );
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
  expect(
    calls.filter((call) => call.url === "https://auth.example/token").length,
  ).toStrictEqual(1);
});

test("YamlForwardingExecutor deduplicates OAuth2 fetches and shares the cache across reloads", async () => {
  let tokenCalls = 0;
  let releaseToken!: () => void;
  const tokenGate = new Promise<void>((resolve) => (releaseToken = resolve));
  const cache = createOAuthTokenCache();
  const config = configFor(`
- target: ^https://internal[.]example/.*$
  request:
    auth:
      type: oauth2
      issuer: https://auth.example/token
      clientId: connector
      clientSecret: secret
`);
  const nextFetch = (async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === "https://auth.example/token") {
      tokenCalls += 1;
      await tokenGate;
      return Response.json({ access_token: "shared-token", expires_in: 60 });
    }
    return new Response("ok");
  }) as Fetcher;
  const first = await createYamlForwardingExecutor({
    config,
    configPath: "test.yml",
    logger: silentLogger,
    nextFetch,
    oauthTokenCache: cache,
  });
  const second = await createYamlForwardingExecutor({
    config,
    configPath: "test.yml",
    logger: silentLogger,
    nextFetch,
    oauthTokenCache: cache,
  });
  const frame = {
    type: "request" as const,
    requestId: "request-1",
    request: { method: "GET" as const, url: "https://internal.example/items" },
  };
  const requests = [first.execute(frame), first.execute(frame)];
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(tokenCalls).toStrictEqual(1);
  releaseToken();
  await Promise.all(requests);
  await second.execute(frame);
  expect(tokenCalls).toStrictEqual(1);
});

test("YamlForwardingExecutor supports Basic auth and reports OAuth2 failures", async () => {
  let authorization: string | null = null;
  const basic = await createYamlForwardingExecutor({
    config: configFor(`
- target: ^https://internal[.]example/.*$
  request:
    auth:
      type: basic
      username: "{{ env.USERNAME }}"
      password: "{{ env.PASSWORD }}"
`),
    configPath: "test.yml",
    env: { USERNAME: "api-user", PASSWORD: "päss" },
    logger: silentLogger,
    nextFetch: ((input) => {
      authorization = (input as Request).headers.get("authorization");
      return Promise.resolve(new Response("ok"));
    }) as Fetcher,
  });
  await basic.execute({
    type: "request",
    requestId: "basic-1",
    request: { method: "GET", url: "https://internal.example/items" },
  });
  expect(authorization).toStrictEqual("Basic YXBpLXVzZXI6cMOkc3M=");

  for (const failure of ["throw", "status", "missing-token"] as const) {
    const executor = await createYamlForwardingExecutor({
      config: configFor(`
- target: ^https://internal[.]example/.*$
  request:
    auth:
      type: oauth2
      issuer: https://auth.example/token
      clientId: connector
      clientSecret: secret
`),
      configPath: "test.yml",
      logger: silentLogger,
      nextFetch: (() => {
        if (failure === "throw") return Promise.reject(new Error("offline"));
        if (failure === "status") {
          return Promise.resolve(new Response(null, { status: 503 }));
        }
        return Promise.resolve(Response.json({}));
      }) as Fetcher,
    });
    await expect(
      executor.execute({
        type: "request",
        requestId: failure,
        request: { method: "GET", url: "https://internal.example/items" },
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        name: "RuntimeError",
        code: "TARGET_REQUEST_ERROR",
      }),
    );
  }
});

test("YamlForwardingExecutor strips inbound credentials unless explicitly enabled", async () => {
  for (const forwardIncomingCredentials of [false, true]) {
    let request!: Request;
    const option = forwardIncomingCredentials
      ? "\n  request:\n    forwardIncomingCredentials: true"
      : "";
    const executor = await createYamlForwardingExecutor({
      config: configFor(`- target: ^https://internal[.]example/.*$${option}`),
      configPath: "test.yml",
      logger: silentLogger,
      nextFetch: ((input) => {
        request = input as Request;
        return Promise.resolve(new Response("ok"));
      }) as Fetcher,
    });
    await executor.execute({
      type: "request",
      requestId: "credentials",
      request: {
        method: "GET",
        url: "https://internal.example/items",
        headers: {
          authorization: ["Bearer caller"],
          cookie: ["session=secret"],
          "proxy-authorization": ["Basic secret"],
        },
      },
    });
    expect(request.headers.get("authorization")).toStrictEqual(
      forwardIncomingCredentials ? "Bearer caller" : null,
    );
    expect(request.headers.get("cookie")).toStrictEqual(
      forwardIncomingCredentials ? "session=secret" : null,
    );
  }
});

test("YamlForwardingExecutor scopes redirect authorization to initially matched rules", async () => {
  const calls: string[] = [];
  const executor = await createYamlForwardingExecutor({
    config: configFor(`
- target: ^https://one[.]example/.*$
- target: ^https://two[.]example/.*$
`),
    configPath: "test.yml",
    logger: silentLogger,
    nextFetch: ((input) => {
      const request = input as Request;
      calls.push(request.url);
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://two.example/secret" },
        }),
      );
    }) as Fetcher,
  });
  await expect(
    executor.execute({
      type: "request",
      requestId: "redirect",
      request: { method: "GET", url: "https://one.example/start" },
    }),
  ).rejects.toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      code: "OUTBOUND_URL_NOT_ALLOWED",
    }),
  );
  expect(calls).toStrictEqual(["https://one.example/start"]);
});

test("YamlForwardingExecutor caps response bodies and honors protocol timeouts", async () => {
  expect(effectiveTimeout(undefined, undefined)).toStrictEqual(30_000);
  expect(effectiveTimeout(20_000, 5)).toStrictEqual(5_000);
  expect(effectiveTimeout(2_000, 5)).toStrictEqual(2_000);

  const executor = await createYamlForwardingExecutor({
    config: {
      ...configFor("- target: ^https://internal[.]example/.*$"),
      maxResponseBodyBytes: 4,
    },
    configPath: "test.yml",
    logger: silentLogger,
    nextFetch: (() => Promise.resolve(new Response("12345"))) as Fetcher,
  });
  await expect(
    executor.execute({
      type: "request",
      requestId: "large",
      request: { method: "GET", url: "https://internal.example/items" },
    }),
  ).rejects.toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      code: "RESPONSE_TOO_LARGE",
    }),
  );
});

test("mergeForwardingConfigs applies later explicit values and header entries", () => {
  expect(
    mergeForwardingConfigs([
      {
        target: "first",
        methods: ["GET"],
        timeout: 1000,
        request: {
          headers: {
            set: { "x-one": "1", "x-shared": "old" },
            add: { "x-add": "one" },
          },
          auth: { type: "basic", username: "user", password: "secret" },
        },
      },
      {
        target: "second",
        methods: [],
        request: {
          headers: {
            set: { "X-Shared": "new" },
            add: { "X-Add": "two" },
            remove: ["x-one"],
          },
        },
      },
    ]),
  ).toStrictEqual({
    target: "second",
    methods: [],
    timeout: 1000,
    request: {
      headers: {
        remove: ["x-one"],
        set: { "X-Shared": "new" },
        add: { "X-Add": ["one", "two"] },
      },
      pathPrefix: undefined,
      forwardIncomingCredentials: undefined,
      auth: undefined,
    },
  });
});

test("maintained templates contain valid complete connector YAML", async () => {
  const schemaPath = fileURLToPath(
    new URL("../schemas/cloud-connector.schema.json", import.meta.url),
  );
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const Ajv2020 = Ajv2020Module.default;
  const addFormats = addFormatsModule.default;
  const validateSchema = addFormats(new Ajv2020({ strict: false })).compile(
    schema,
  );
  for (const path of [
    fileURLToPath(
      new URL(
        "../templates/starter/config/cloud-connector.yml",
        import.meta.url,
      ),
    ),
    fileURLToPath(
      new URL(
        "../templates/examples/ticketing-yaml/config/cloud-connector.yml",
        import.meta.url,
      ),
    ),
  ]) {
    const yaml = await readFile(path, "utf8");
    expect(validateSchema(parseYaml(yaml))).toBeTruthy();
    const config = combineConfig(environment, await loadVolumeConfig(path));
    await createYamlForwardingExecutor({
      config,
      configPath: path,
      logger: silentLogger,
    });
  }
});

test("interpolate exposes only documented declarative values", () => {
  expect(
    interpolate(
      "Bearer {{ env.API_TOKEN }} / {{ context.requestId }}",
      baseContext,
    ),
  ).toStrictEqual("Bearer secret-token / test-request-id");
  expect(() => interpolate("{{ env.MISSING }}", baseContext)).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("Environment variable MISSING"),
    }),
  );
  expect(() => interpolate("{{ request.url }}", baseContext)).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining(
        "Unsupported forwarding interpolation expression",
      ),
    }),
  );
});

test("YAML request and response transformations remain declarative", () => {
  const requestConfig: YamlRequestForwardingConfig = {
    headers: {
      set: { authorization: "Bearer {{ env.API_TOKEN }}" },
      add: { "x-tenant-id": "{{ env.TENANT_ID }}" },
      remove: ["x-internal"],
    },
    pathPrefix: "/v2",
  };
  expect(
    applyYamlRequestForwardingConfig(
      requestConfig,
      {
        method: "GET",
        url: "https://internal.example/users?active=true",
        headers: { "x-internal": ["secret"] },
      },
      baseContext,
    ),
  ).toStrictEqual({
    method: "GET",
    url: "https://internal.example/v2/users?active=true",
    headers: {
      authorization: ["Bearer secret-token"],
      "x-tenant-id": ["tenant-123"],
    },
  });

  const responseConfig: YamlResponseForwardingConfig = {
    headers: { add: { "x-request-id": "{{ context.requestId }}" } },
  };
  expect(
    applyYamlResponseForwardingConfig(
      responseConfig,
      { statusCode: 200, headers: {}, body: "original" },
      baseContext,
    ),
  ).toStrictEqual({
    statusCode: 200,
    headers: { "x-request-id": ["test-request-id"] },
    body: "original",
  });
});

test("YAML validates rules, authentication, and path prefixes", () => {
  for (const yaml of [
    "- target: '('",
    "- target: ^https://internal[.]example(?:/.*)?$\n  request:\n    auth:\n      type: bearer",
    "- target: ^https://internal[.]example(?:/.*)?$\n  request:\n    auth:\n      type: basic\n      username: user",
    "- target: ^https://internal[.]example(?:/.*)?$\n  request:\n    auth:\n      type: basic\n      username: user\n      password: secret\n      extra: invalid",
    "- target: ^https://internal[.]example(?:/.*)?$\n  request:\n    auth:\n      type: oauth2\n      issuer: relative\n      clientId: id\n      clientSecret: secret",
    "- target: ^https://internal[.]example(?:/.*)?$\n  request:\n    pathPrefix: //unsafe",
    "- target: ^https://internal[.]example(?:/.*)?$\n  response:\n    body:\n      set: changed",
  ])
    expect(() => configFor(yaml)).toThrow(RuntimeError);
});
