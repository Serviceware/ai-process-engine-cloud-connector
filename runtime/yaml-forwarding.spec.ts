import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, vi } from "vitest";
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
  return combineConfig(environment, parseVolumeConfig("connection: {}\nforwarding:\n" + indented + "\n"));
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
  expect(calls[0].url).toStrictEqual("https://internal.example/api/orders?state=open");
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
    config: configFor("- target: ^https://internal[.]example/.*$\n  methods: []"),
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
  const tokenBodies: string[] = [];
  const targetAuthorizations: (string | null)[] = [];
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
      if (request.url === "https://auth.example/token") {
        tokenBodies.push(await request.text());
        return Response.json({ access_token: "oauth-token", expires_in: 60 });
      }
      targetAuthorizations.push(request.headers.get("authorization"));
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
  expect(tokenBodies).toStrictEqual([
    "grant_type=client_credentials&client_id=connector&client_secret=secret&scope=inventory.read",
  ]);
  expect(targetAuthorizations).toStrictEqual(["Bearer oauth-token", "Bearer oauth-token"]);
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
    const option = forwardIncomingCredentials ? "\n  request:\n    forwardIncomingCredentials: true" : "";
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
    expect(request.headers.get("authorization")).toStrictEqual(forwardIncomingCredentials ? "Bearer caller" : null);
    expect(request.headers.get("cookie")).toStrictEqual(forwardIncomingCredentials ? "session=secret" : null);
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
  const schemaPath = fileURLToPath(new URL("../schemas/cloud-connector.schema.json", import.meta.url));
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const Ajv2020 = Ajv2020Module.default;
  const addFormats = addFormatsModule.default;
  const validateSchema = addFormats(new Ajv2020({ strict: false })).compile(schema);
  for (const path of [
    fileURLToPath(new URL("../templates/starter/config/cloud-connector.yml", import.meta.url)),
    fileURLToPath(new URL("../templates/examples/ticketing-yaml/config/cloud-connector.yml", import.meta.url)),
  ]) {
    const yaml = await readFile(path, "utf8");
    expect(
      validateSchema(parseYaml(yaml)),
      `Schema rejected ${path}: ${JSON.stringify(validateSchema.errors)}`,
    ).toBeTruthy();
    const config = combineConfig(environment, await loadVolumeConfig(path));
    await createYamlForwardingExecutor({
      config,
      configPath: path,
      logger: silentLogger,
    });
  }
});

test("interpolate exposes only documented declarative values", () => {
  expect(interpolate("Bearer {{ env.API_TOKEN }} / {{ context.requestId }}", baseContext)).toStrictEqual(
    "Bearer secret-token / test-request-id",
  );
  expect(() => interpolate("{{ env.MISSING }}", baseContext)).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("Environment variable MISSING"),
    }),
  );
  expect(() => interpolate("{{ request.url }}", baseContext)).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("Unsupported forwarding interpolation expression"),
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
    applyYamlResponseForwardingConfig(responseConfig, { statusCode: 200, headers: {}, body: "original" }, baseContext),
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

test("YamlForwardingExecutor lets fetch derive content-length and drops expect", async () => {
  const received: IncomingHttpHeaders[] = [];
  const target = createServer((request, response) => {
    received.push(request.headers);
    request.resume();
    request.on("end", () => response.end("ok"));
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  try {
    const { port } = target.address() as AddressInfo;
    const executor = await createYamlForwardingExecutor({
      config: configFor("- target: ^http://127[.]0[.]0[.]1:[0-9]+/.*$"),
      configPath: "/config/cloud-connector.yml",
      env: {},
      logger: silentLogger,
    });

    const response = await executor.execute({
      type: "request",
      requestId: "request-1",
      request: {
        method: "POST",
        url: `http://127.0.0.1:${port}/items`,
        headers: {
          "content-length": ["3"],
          expect: ["100-continue"],
        },
        body: "\u00e4\u00f6\u00fc",
      },
    });

    expect(response.statusCode).toStrictEqual(200);
    expect(received[0]["content-length"]).toStrictEqual("6");
    expect(received[0].expect).toBeUndefined();
  } finally {
    target.close();
  }
});

test("YamlForwardingExecutor reports the network reason of failed requests", async () => {
  const warnings: unknown[][] = [];
  const closed = createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const { port } = closed.address() as AddressInfo;
  closed.close();
  await once(closed, "close");
  const executor = await createYamlForwardingExecutor({
    config: configFor("- target: ^http://127[.]0[.]0[.]1:[0-9]+/.*$"),
    configPath: "/config/cloud-connector.yml",
    env: {},
    logger: createLogger("warn", {
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: (...data) => warnings.push(data),
    }),
  });

  const failure = executor.execute({
    type: "request",
    requestId: "request-1",
    request: { method: "GET", url: `http://127.0.0.1:${port}/items` },
  });

  await expect(failure).rejects.toMatchObject({
    code: "TARGET_REQUEST_ERROR",
    message: "Forwarding request failed: fetch failed (ECONNREFUSED)",
  });
  expect(warnings.flat()).toContainEqual(expect.objectContaining({ message: "fetch failed" }));
});

test("YamlForwardingExecutor names the network reason of failed OAuth2 token requests", async () => {
  const warnings: unknown[][] = [];
  const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
    code: "ECONNREFUSED",
  });
  const fetchError = new TypeError("fetch failed", { cause: refused });
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
    logger: createLogger("warn", {
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: (...data) => warnings.push(data),
    }),
    nextFetch: (() => Promise.reject(fetchError)) as Fetcher,
  });

  await expect(
    executor.execute({
      type: "request",
      requestId: "request-1",
      request: { method: "GET", url: "https://internal.example/items" },
    }),
  ).rejects.toMatchObject({
    code: "TARGET_REQUEST_ERROR",
    message: "OAuth2 token request failed: fetch failed (ECONNREFUSED)",
  });
  expect(warnings.flat()).toContain(fetchError);
});

const oauthRule = `
- target: ^https://internal[.]example/.*$
  request:
    auth:
      type: oauth2
      issuer: https://auth.example/token
      clientId: connector
      clientSecret: secret
`;

const itemsFrame = {
  type: "request" as const,
  requestId: "request-1",
  request: { method: "GET" as const, url: "https://internal.example/items" },
};

async function oauthExecutor(tokenResponses: () => Response, tokenCalls: { count: number }) {
  return await createYamlForwardingExecutor({
    config: configFor(oauthRule),
    configPath: "test.yml",
    logger: silentLogger,
    nextFetch: ((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://auth.example/token") {
        tokenCalls.count += 1;
        return Promise.resolve(tokenResponses());
      }
      return Promise.resolve(new Response("ok"));
    }) as Fetcher,
  });
}

test("YamlForwardingExecutor sends the OAuth2 token request as a non-redirecting form POST", async () => {
  const seen: { input: unknown; init: RequestInit | undefined }[] = [];
  for (const scope of [undefined, "inventory.read"]) {
    seen.length = 0;
    const executor = await createYamlForwardingExecutor({
      config: configFor(oauthRule + (scope ? `      scope: ${scope}\n` : "")),
      configPath: "test.yml",
      logger: silentLogger,
      nextFetch: ((input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === "https://auth.example/token") {
          seen.push({ input, init });
          return Promise.resolve(Response.json({ access_token: "t", expires_in: 60 }));
        }
        return Promise.resolve(new Response("ok"));
      }) as Fetcher,
    });
    await executor.execute(itemsFrame);

    expect(seen.length).toStrictEqual(1);
    expect(seen[0].input).toStrictEqual("https://auth.example/token");
    expect(seen[0].init?.method).toStrictEqual("POST");
    expect(seen[0].init?.redirect).toStrictEqual("error");
    expect(seen[0].init?.headers).toStrictEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(seen[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(String(seen[0].init?.body)).toStrictEqual(
      `grant_type=client_credentials&client_id=connector&client_secret=secret${scope ? `&scope=${scope}` : ""}`,
    );
  }
});

test("YamlForwardingExecutor refetches an OAuth2 token within five seconds of expiry", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const calls = { count: 0 };
    const executor = await oauthExecutor(() => Response.json({ access_token: "t", expires_in: 60 }), calls);

    await executor.execute(itemsFrame);
    vi.advanceTimersByTime(54_999);
    await executor.execute(itemsFrame);
    expect(calls.count).toStrictEqual(1);

    vi.advanceTimersByTime(1);
    await executor.execute(itemsFrame);
    expect(calls.count).toStrictEqual(2);
  } finally {
    vi.useRealTimers();
  }
});

test("YamlForwardingExecutor caches OAuth2 tokens for 300 seconds when expires_in is absent or unusable", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    for (const expiresIn of [undefined, 0, -30, null, "3600", Number.NaN]) {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const calls = { count: 0 };
      const executor = await oauthExecutor(() => Response.json({ access_token: "t", expires_in: expiresIn }), calls);

      await executor.execute(itemsFrame);
      vi.advanceTimersByTime(294_999);
      await executor.execute(itemsFrame);
      expect(calls.count, `expires_in=${String(expiresIn)} before expiry window`).toStrictEqual(1);

      vi.advanceTimersByTime(1);
      await executor.execute(itemsFrame);
      expect(calls.count, `expires_in=${String(expiresIn)} inside expiry window`).toStrictEqual(2);
    }
  } finally {
    vi.useRealTimers();
  }
});

test("YamlForwardingExecutor keys the shared OAuth2 cache by the interpolated client secret", async () => {
  const tokenBodies: string[] = [];
  const cache = createOAuthTokenCache();
  const config = configFor(`
- target: ^https://internal[.]example/.*$
  request:
    auth:
      type: oauth2
      issuer: https://auth.example/token
      clientId: connector
      clientSecret: "{{ env.SECRET }}"
`);
  const nextFetch = ((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === "https://auth.example/token") {
      tokenBodies.push(String(init?.body));
      return Promise.resolve(Response.json({ access_token: `token-${tokenBodies.length}`, expires_in: 600 }));
    }
    return Promise.resolve(new Response("ok"));
  }) as Fetcher;
  const executors = await Promise.all(
    ["one", "two"].map((SECRET) =>
      createYamlForwardingExecutor({
        config,
        configPath: "test.yml",
        env: { SECRET },
        logger: silentLogger,
        nextFetch,
        oauthTokenCache: cache,
      }),
    ),
  );
  for (const executor of [...executors, ...executors]) await executor.execute(itemsFrame);
  expect(tokenBodies).toStrictEqual([
    "grant_type=client_credentials&client_id=connector&client_secret=one",
    "grant_type=client_credentials&client_id=connector&client_secret=two",
  ]);
});

test("YamlForwardingExecutor clears the in-flight OAuth2 entry after a failed token request", async () => {
  const cache = createOAuthTokenCache();
  let fail = true;
  const executor = await createYamlForwardingExecutor({
    config: configFor(oauthRule),
    configPath: "test.yml",
    logger: silentLogger,
    oauthTokenCache: cache,
    nextFetch: ((input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== "https://auth.example/token") return Promise.resolve(new Response("ok"));
      return Promise.resolve(fail ? new Response(null, { status: 401 }) : Response.json({ access_token: "t" }));
    }) as Fetcher,
  });
  await expect(executor.execute(itemsFrame)).rejects.toMatchObject({
    code: "TARGET_REQUEST_ERROR",
    message: "OAuth2 token endpoint returned HTTP 401",
  });
  expect(cache.inFlight.size).toStrictEqual(0);
  expect(cache.tokens.size).toStrictEqual(0);

  fail = false;
  await executor.execute(itemsFrame);
  expect(cache.tokens.size).toStrictEqual(1);
});

test("YamlForwardingExecutor rejects an OAuth2 response whose access_token is not a non-empty string", async () => {
  for (const accessToken of [123, "", null]) {
    const executor = await oauthExecutor(() => Response.json({ access_token: accessToken }), { count: 0 });
    await expect(executor.execute(itemsFrame)).rejects.toMatchObject({
      code: "TARGET_REQUEST_ERROR",
      message: "OAuth2 token response does not contain access_token",
    });
  }
});

test("YamlForwardingExecutor adds a Bearer token and replaces inbound authorization", async () => {
  for (const forwardIncomingCredentials of [false, true]) {
    let request!: Request;
    const executor = await createYamlForwardingExecutor({
      config: configFor(`
- target: ^https://internal[.]example/.*$
  request:
    forwardIncomingCredentials: ${forwardIncomingCredentials}
    headers:
      set:
        authorization: Bearer from-header-set
    auth:
      type: bearer
      token: "{{ env.TOKEN }}"
`),
      configPath: "test.yml",
      env: { TOKEN: "static-token" },
      logger: silentLogger,
      nextFetch: ((input) => {
        request = input as Request;
        return Promise.resolve(new Response("ok"));
      }) as Fetcher,
    });
    await executor.execute({
      ...itemsFrame,
      request: { ...itemsFrame.request, headers: { Authorization: ["Bearer caller"] } },
    });
    expect(request.headers.get("authorization")).toStrictEqual("Bearer static-token");
  }
});

test("YamlForwardingExecutor fails with CONFIG_ERROR when auth values are unset or empty", async () => {
  for (const env of [{}, { TOKEN: "" }] as Record<string, string>[]) {
    const executor = await createYamlForwardingExecutor({
      config: configFor(`
- target: ^https://internal[.]example/.*$
  request:
    auth:
      type: bearer
      token: "{{ env.TOKEN }}"
`),
      configPath: "test.yml",
      env,
      logger: silentLogger,
      nextFetch: (() => Promise.reject(new Error("must not be called"))) as Fetcher,
    });
    await expect(executor.execute(itemsFrame)).rejects.toMatchObject({ name: "RuntimeError", code: "CONFIG_ERROR" });
  }
});

test("YamlForwardingExecutor applies header remove, set, and add case-insensitively on request and response", async () => {
  let request!: Request;
  const executor = await createYamlForwardingExecutor({
    config: configFor(`
- target: ^https://internal[.]example/.*$
  request:
    headers:
      remove: [X-Internal]
      set:
        X-Mode: replaced
      add:
        X-Trace: second
  response:
    headers:
      remove: [X-Secret]
      set:
        X-Served-By: connector
      add:
        X-Extra: "{{ context.requestId }}"
`),
    configPath: "test.yml",
    logger: silentLogger,
    nextFetch: ((input) => {
      request = input as Request;
      return Promise.resolve(
        new Response("ok", { headers: { "x-secret": "hide", "x-served-by": "upstream", "x-extra": "kept" } }),
      );
    }) as Fetcher,
  });
  const response = await executor.execute({
    ...itemsFrame,
    request: {
      ...itemsFrame.request,
      headers: { "x-internal": ["a"], "x-mode": ["original"], "x-trace": ["first"] },
    },
  });

  expect(request.headers.get("x-internal")).toStrictEqual(null);
  expect(request.headers.get("x-mode")).toStrictEqual("replaced");
  expect(request.headers.get("x-trace")).toStrictEqual("first, second");
  expect(response.headers?.["x-secret"]).toBeUndefined();
  expect(response.headers?.["X-Served-By"]).toStrictEqual(["connector"]);
  expect(response.headers?.["X-Extra"]).toStrictEqual(["kept", "request-1"]);
});

test("applyYamlRequestForwardingConfig normalizes header casing and path prefixes", () => {
  const request = { method: "GET" as const, url: "https://internal.example/users?active=true#frag", headers: {} };
  const withPrefix = (pathPrefix: string, url = request.url) =>
    applyYamlRequestForwardingConfig({ pathPrefix }, { ...request, url }, baseContext).url;

  expect(withPrefix("/api")).toStrictEqual("https://internal.example/api/users?active=true#frag");
  expect(withPrefix("/api/")).toStrictEqual("https://internal.example/api/users?active=true#frag");
  expect(withPrefix("/")).toStrictEqual(request.url);
  expect(withPrefix("/api", "https://internal.example")).toStrictEqual("https://internal.example/api/");

  const renamed = applyYamlRequestForwardingConfig(
    { headers: { add: { "X-Trace": "b" }, set: { "x-mode": "new" } } },
    { ...request, headers: { "x-trace": ["a"], "X-MODE": ["old"] } },
    baseContext,
  );
  expect(renamed.headers).toStrictEqual({ "X-Trace": ["a", "b"], "x-mode": ["new"] });
});

test("YamlForwardingExecutor denies a path prefix that moves the URL outside the matched rules", async () => {
  const calls: string[] = [];
  const executor = await createYamlForwardingExecutor({
    config: configFor(`
- target: ^https://internal[.]example/orders$
  request:
    pathPrefix: /admin
`),
    configPath: "test.yml",
    logger: silentLogger,
    nextFetch: ((input) => {
      calls.push((input as Request).url);
      return Promise.resolve(new Response("ok"));
    }) as Fetcher,
  });
  await expect(
    executor.execute({ ...itemsFrame, request: { method: "GET", url: "https://internal.example/orders" } }),
  ).rejects.toMatchObject({ code: "OUTBOUND_URL_NOT_ALLOWED" });
  expect(calls).toStrictEqual([]);
});

test("YamlForwardingExecutor rejects requested URLs that are relative or not HTTP(S)", async () => {
  const executor = await createYamlForwardingExecutor({
    config: configFor("- target: ^.*$"),
    configPath: "/config/cloud-connector.yml",
    logger: silentLogger,
    nextFetch: (() => Promise.reject(new Error("must not be called"))) as Fetcher,
  });
  await expect(executor.execute({ ...itemsFrame, request: { method: "GET", url: "/items" } })).rejects.toMatchObject({
    code: "OUTBOUND_URL_NOT_ALLOWED",
    message: "Requested URL must be absolute in /config/cloud-connector.yml",
    cause: expect.any(TypeError),
  });
  await expect(
    executor.execute({ ...itemsFrame, request: { method: "GET", url: "ftp://internal.example/items" } }),
  ).rejects.toMatchObject({
    code: "OUTBOUND_URL_NOT_ALLOWED",
    message: "Requested URL must use HTTP or HTTPS in /config/cloud-connector.yml",
  });
});

test("YamlForwardingExecutor sends no body for GET and HEAD and honors the method list of the last matching rule", async () => {
  const seen: { method: string; body: string }[] = [];
  const executor = await createYamlForwardingExecutor({
    config: configFor(`
- target: ^https://internal[.]example/.*$
  methods: [GET]
- target: ^https://internal[.]example/items$
  methods: [HEAD, POST]
`),
    configPath: "test.yml",
    logger: silentLogger,
    nextFetch: (async (input) => {
      const request = input as Request;
      seen.push({ method: request.method, body: await request.text() });
      return new Response(null, { status: 204 });
    }) as Fetcher,
  });
  const frame = (method: "GET" | "HEAD" | "POST") => ({
    ...itemsFrame,
    request: { method, url: "https://internal.example/items", body: "payload" },
  });

  await executor.execute(frame("HEAD"));
  await executor.execute(frame("POST"));
  await expect(executor.execute(frame("GET"))).rejects.toMatchObject({ code: "METHOD_NOT_ALLOWED" });
  expect(seen).toStrictEqual([
    { method: "HEAD", body: "" },
    { method: "POST", body: "payload" },
  ]);
  await expect(
    executor.execute({ ...itemsFrame, request: { method: "GET", url: "https://internal.example/other", body: "x" } }),
  ).resolves.toMatchObject({ statusCode: 204 });
  expect(seen.at(-1)).toStrictEqual({ method: "GET", body: "" });
});

test("YamlForwardingExecutor reports TIMEOUT when the upstream outlives the effective timeout", async () => {
  const executor = await createYamlForwardingExecutor({
    config: configFor("- target: ^https://internal[.]example/.*$\n  timeout: 60000"),
    configPath: "test.yml",
    logger: silentLogger,
    nextFetch: ((input) =>
      new Promise((_, reject) => {
        (input as Request).signal.addEventListener("abort", () => reject((input as Request).signal.reason));
      })) as Fetcher,
  });
  await expect(
    executor.execute({ ...itemsFrame, request: { ...itemsFrame.request, timeoutSeconds: 0.05 } }),
  ).rejects.toMatchObject({
    name: "RuntimeError",
    code: "TIMEOUT",
    message: "Forwarding request timed out after 50ms",
    cause: expect.objectContaining({ name: "TimeoutError" }),
  });
});

test("YamlForwardingExecutor enforces the response size limit by declared length and while streaming", async () => {
  const run = async (response: () => Response, maxResponseBodyBytes = 4) => {
    const executor = await createYamlForwardingExecutor({
      config: { ...configFor("- target: ^https://internal[.]example/.*$"), maxResponseBodyBytes },
      configPath: "test.yml",
      logger: silentLogger,
      nextFetch: (() => Promise.resolve(response())) as Fetcher,
    });
    return await executor.execute(itemsFrame);
  };
  const streamOf = (...chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  const encoder = new TextEncoder();

  await expect(run(() => new Response("1234"))).resolves.toMatchObject({ body: "1234" });
  await expect(run(() => new Response("12345", { headers: { "content-length": "5" } }))).rejects.toMatchObject({
    code: "RESPONSE_TOO_LARGE",
    message: "Target response exceeds the 4-byte limit",
  });
  await expect(run(() => new Response(streamOf(encoder.encode("123"), encoder.encode("45"))))).rejects.toMatchObject({
    code: "RESPONSE_TOO_LARGE",
  });
  await expect(run(() => new Response(streamOf(encoder.encode("ääh"))))).rejects.toMatchObject({
    code: "RESPONSE_TOO_LARGE",
  });
  await expect(run(() => new Response("ää"))).resolves.toMatchObject({ body: "ää" });
});

test("YamlForwardingExecutor decodes multi-byte characters split across chunks and maps empty bodies to null", async () => {
  const bytes = new TextEncoder().encode("ä");
  const executor = await createYamlForwardingExecutor({
    config: configFor("- target: ^https://internal[.]example/.*$"),
    configPath: "test.yml",
    logger: silentLogger,
    nextFetch: (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, 1));
              controller.enqueue(bytes.slice(1));
              controller.close();
            },
          }),
        ),
      )) as Fetcher,
  });
  expect((await executor.execute(itemsFrame)).body).toStrictEqual("ä");

  const empty = await createYamlForwardingExecutor({
    config: configFor("- target: ^https://internal[.]example/.*$"),
    configPath: "test.yml",
    logger: silentLogger,
    nextFetch: (() => Promise.resolve(new Response(""))) as Fetcher,
  });
  expect((await empty.execute(itemsFrame)).body).toStrictEqual(null);
  const noBody = await createYamlForwardingExecutor({
    config: configFor("- target: ^https://internal[.]example/.*$"),
    configPath: "test.yml",
    logger: silentLogger,
    nextFetch: (() => Promise.resolve(new Response(null, { status: 204 }))) as Fetcher,
  });
  expect((await noBody.execute(itemsFrame)).body).toStrictEqual(null);
});

test("mergeForwardingConfigs carries unset values forward and copies the methods array", () => {
  const merged = mergeForwardingConfigs([
    {
      target: "a",
      request: { pathPrefix: "/one", forwardIncomingCredentials: true, headers: { set: { "x-a": "1" } } },
      response: { headers: { set: { "x-r": "1" } } },
    },
    {
      target: "b",
      timeout: 2000,
      request: { headers: { set: { "X-B": "2" } } },
      response: { headers: { set: { "x-s": "2" } } },
    },
    { target: "c", request: { pathPrefix: "/three" } },
  ]);
  expect(merged.target).toStrictEqual("c");
  expect(merged.timeout).toStrictEqual(2000);
  expect(merged.methods).toBeUndefined();
  expect(merged.request).toMatchObject({ pathPrefix: "/three", forwardIncomingCredentials: true });
  expect(merged.request?.headers).toStrictEqual({ set: { "x-a": "1", "X-B": "2" } });
  expect(merged.response?.headers).toStrictEqual({ set: { "x-r": "1", "x-s": "2" } });

  const methods = ["GET"];
  const copied = mergeForwardingConfigs([{ target: "a", methods }]);
  copied.methods?.push("POST");
  expect(methods).toStrictEqual(["GET"]);
});

test("interpolate supports both env syntaxes and rejects unknown or nested expressions", () => {
  expect(interpolate("{{env:API_TOKEN}}|{{ env.TENANT_ID }}|{{context.startedAt}}", baseContext)).toStrictEqual(
    "secret-token|tenant-123|2024-01-01T00:00:00.000Z",
  );
  for (const expression of ["env.A.B", "context.nope", "context", "env", "other.value"]) {
    expect(() => interpolate(`{{ ${expression} }}`, baseContext)).toThrow(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        message: `Unsupported forwarding interpolation expression: ${expression}`,
      }),
    );
  }
  expect(interpolate("no placeholders", baseContext)).toStrictEqual("no placeholders");
});
