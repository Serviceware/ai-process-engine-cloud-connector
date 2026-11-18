import { expect, test } from "vitest";
import { generateAccessToken } from "./access-token.ts";

test("generateAccessToken resolves issuer and requests a client credentials token", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ url, init });

      if (url === "https://cloud.example/.well-known") {
        return Promise.resolve(
          Response.json({
            auth: { issuer: "https://cloud.example/realms/serviceware" },
          }),
        );
      }

      if (url === "https://cloud.example/realms/serviceware/protocol/openid-connect/token") {
        return Promise.resolve(Response.json({ access_token: "access-token" }));
      }

      return Promise.resolve(new Response(null, { status: 404 }));
    },
  });

  try {
    const accessToken = await generateAccessToken({
      host: "https://cloud.example/",
      clientId: "client-id",
      clientSecret: "client-secret",
    });

    expect(accessToken).toStrictEqual("access-token");
    expect(calls.length).toStrictEqual(2);
    expect(calls[0].url).toStrictEqual("https://cloud.example/.well-known");
    expect(calls[1].url).toStrictEqual("https://cloud.example/realms/serviceware/protocol/openid-connect/token");
    expect(calls[1].init?.method).toStrictEqual("POST");
    expect(calls[1].init?.redirect).toStrictEqual("error");
    expect(calls[1].init?.headers).toStrictEqual({
      "Content-Type": "application/x-www-form-urlencoded",
    });

    const body = calls[1].init?.body as URLSearchParams;
    expect(body.get("grant_type")).toStrictEqual("client_credentials");
    expect(body.get("client_id")).toStrictEqual("client-id");
    expect(body.get("client_secret")).toStrictEqual("client-secret");
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  }
});

test("generateAccessToken rejects token responses without access token", async () => {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://cloud.example/.well-known") {
        return Promise.resolve(
          Response.json({
            auth: { issuer: "https://cloud.example/realms/serviceware" },
          }),
        );
      }

      return Promise.resolve(Response.json({}));
    },
  });

  try {
    await expect(
      generateAccessToken({
        host: "https://cloud.example/",
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
    ).rejects.toThrow("Access token not found in token response.");
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  }
});

test("generateAccessToken accepts the issuer returned by the Cloud context", async () => {
  const calls: string[] = [];
  const accessToken = await generateAccessToken({
    host: "https://cloud.example/",
    clientId: "client-id",
    clientSecret: "client-secret",
    fetcher: (input) => {
      const url = input.toString();
      calls.push(url);
      if (url === "https://cloud.example/.well-known") {
        return Promise.resolve(
          Response.json({
            auth: {
              issuer: "https://identity.customer.example/realms/serviceware",
            },
          }),
        );
      }
      return Promise.resolve(Response.json({ access_token: "access-token" }));
    },
  });

  expect(accessToken).toStrictEqual("access-token");
  expect(calls).toStrictEqual([
    "https://cloud.example/.well-known",
    "https://identity.customer.example/realms/serviceware/protocol/openid-connect/token",
  ]);
});

test("generateAccessToken rejects malformed issuer URLs before sending credentials", async () => {
  for (const issuer of [
    "https://user:password@sso.swop.cloud/realms/serviceware",
    "https://sso.swop.cloud/realms/serviceware?next=attacker",
    "https://sso.swop.cloud/realms/serviceware#fragment",
  ]) {
    let calls = 0;
    await expect(
      generateAccessToken({
        host: "https://cloud.example/",
        clientId: "client-id",
        clientSecret: "client-secret",
        fetcher: () => {
          calls++;
          return Promise.resolve(Response.json({ auth: { issuer } }));
        },
      }),
    ).rejects.toThrow("must not contain credentials, query parameters, or a fragment");
    expect(calls).toStrictEqual(1);
  }
});

const credentials = { host: "https://cloud.example", clientId: "client-id", clientSecret: "client-secret" };

test("generateAccessToken fails when the well-known request is not OK", async () => {
  let calls = 0;
  await expect(
    generateAccessToken({
      ...credentials,
      fetcher: () => {
        calls++;
        return Promise.resolve(new Response(null, { status: 503, statusText: "Service Unavailable" }));
      },
    }),
  ).rejects.toThrow("Failed to fetch well-known configuration: Service Unavailable");
  expect(calls).toStrictEqual(1);
});

test("generateAccessToken rejects well-known documents without a usable issuer", async () => {
  for (const wellKnown of [
    {},
    { auth: {} },
    { auth: { issuer: "" } },
    { auth: { issuer: 42 } },
    { auth: { issuer: null } },
  ]) {
    let calls = 0;
    await expect(
      generateAccessToken({
        ...credentials,
        fetcher: () => {
          calls++;
          return Promise.resolve(Response.json(wellKnown));
        },
      }),
    ).rejects.toThrow("Authentication endpoint not found in well-known configuration.");
    expect(calls).toStrictEqual(1);
  }
});

test("generateAccessToken fails when the token endpoint is not OK", async () => {
  await expect(
    generateAccessToken({
      ...credentials,
      fetcher: (input) =>
        Promise.resolve(
          input.toString().endsWith("/.well-known")
            ? Response.json({ auth: { issuer: "https://sso.example/realms/r" } })
            : new Response(null, { status: 401, statusText: "Unauthorized" }),
        ),
    }),
  ).rejects.toThrow("Failed to obtain access token: Unauthorized");
});

test("generateAccessToken rejects an empty access token", async () => {
  await expect(
    generateAccessToken({
      ...credentials,
      fetcher: (input) =>
        Promise.resolve(
          input.toString().endsWith("/.well-known")
            ? Response.json({ auth: { issuer: "https://sso.example/realms/r" } })
            : Response.json({ access_token: "" }),
        ),
    }),
  ).rejects.toThrow("Access token not found in token response.");
});

test("generateAccessToken rejects a non-string access token", async () => {
  await expect(
    generateAccessToken({
      ...credentials,
      fetcher: (input) =>
        Promise.resolve(
          input.toString().endsWith("/.well-known")
            ? Response.json({ auth: { issuer: "https://sso.example/realms/r" } })
            : Response.json({ access_token: 123 }),
        ),
    }),
  ).rejects.toThrow("Access token not found in token response.");
});

test("generateAccessToken joins hosts and issuers with or without trailing slashes", async () => {
  for (const [host, issuer] of [
    ["https://cloud.example", "https://sso.example/realms/r"],
    ["https://cloud.example/", "https://sso.example/realms/r/"],
    ["https://cloud.example///", "https://sso.example/realms/r//"],
    ["https://cloud.example/base", "https://sso.example/realms/r"],
  ]) {
    const urls: string[] = [];
    await generateAccessToken({
      ...credentials,
      host,
      fetcher: (input) => {
        urls.push(input.toString());
        return Promise.resolve(
          urls.length === 1 ? Response.json({ auth: { issuer } }) : Response.json({ access_token: "t" }),
        );
      },
    });
    expect(urls).toStrictEqual([
      `${host.replace(/\/+$/, "")}/.well-known`,
      "https://sso.example/realms/r/protocol/openid-connect/token",
    ]);
  }
});

test("generateAccessToken passes an abort signal to both fetches", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  await generateAccessToken({
    ...credentials,
    fetcher: (input, init) => {
      signals.push(init?.signal);
      return Promise.resolve(
        input.toString().endsWith("/.well-known")
          ? Response.json({ auth: { issuer: "https://sso.example/realms/r" } })
          : Response.json({ access_token: "t" }),
      );
    },
  });

  expect(signals.length).toStrictEqual(2);
  for (const signal of signals) {
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toStrictEqual(false);
  }
  expect(signals[0]).not.toBe(signals[1]);
});

test("generateAccessToken aborts the well-known fetch after the timeout", async () => {
  await expect(
    generateAccessToken({
      ...credentials,
      timeoutMs: 20,
      fetcher: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    }),
  ).rejects.toThrow(expect.objectContaining({ name: "TimeoutError" }));
});

test("generateAccessToken aborts the token fetch after the timeout", async () => {
  await expect(
    generateAccessToken({
      ...credentials,
      timeoutMs: 20,
      fetcher: (input, init) =>
        input.toString().endsWith("/.well-known")
          ? Promise.resolve(Response.json({ auth: { issuer: "https://sso.example/realms/r" } }))
          : new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            }),
    }),
  ).rejects.toThrow(expect.objectContaining({ name: "TimeoutError" }));
});

test("generateAccessToken aborts both fetches when the external signal aborts", async () => {
  const reason = new Error("shutdown");
  for (const abortDuring of ["well-known", "token"]) {
    const controller = new AbortController();
    const pending = generateAccessToken({
      ...credentials,
      signal: controller.signal,
      fetcher: (input, init) => {
        const isWellKnown = input.toString().endsWith("/.well-known");
        if (isWellKnown && abortDuring === "token") {
          return Promise.resolve(Response.json({ auth: { issuer: "https://sso.example/realms/r" } }));
        }
        return new Promise((_resolve, rejectFetch) => {
          init?.signal?.addEventListener("abort", () => rejectFetch(init.signal?.reason));
          controller.abort(reason);
        });
      },
    });
    await expect(pending).rejects.toBe(reason);
  }
});

test("generateAccessToken does not start fetching with an already aborted external signal", async () => {
  const reason = new Error("already shut down");
  await expect(
    generateAccessToken({
      ...credentials,
      signal: AbortSignal.abort(reason),
      fetcher: (_input, init) =>
        init?.signal?.aborted ? Promise.reject(init.signal.reason) : Promise.resolve(Response.json({})),
    }),
  ).rejects.toBe(reason);
});

test("generateAccessToken rejects an https host with an http issuer before sending credentials", async () => {
  let calls = 0;
  await expect(
    generateAccessToken({
      ...credentials,
      fetcher: () => {
        calls++;
        return Promise.resolve(Response.json({ auth: { issuer: "http://idp.example/realms/r" } }));
      },
    }),
  ).rejects.toThrow("Authentication issuer must use https: when the Cloud host uses https: (got http://idp.example)");
  expect(calls).toStrictEqual(1);
});

test("generateAccessToken rejects issuers with schemes other than http or https", async () => {
  let calls = 0;
  await expect(
    generateAccessToken({
      ...credentials,
      fetcher: () => {
        calls++;
        return Promise.resolve(Response.json({ auth: { issuer: "ftp://idp.example/realms/r" } }));
      },
    }),
  ).rejects.toThrow("Authentication issuer must use http: or https: (got ftp://idp.example)");
  expect(calls).toStrictEqual(1);
});

test("generateAccessToken accepts an http issuer when the host uses http", async () => {
  const urls: string[] = [];
  const accessToken = await generateAccessToken({
    ...credentials,
    host: "http://127.0.0.1:8080",
    fetcher: (input) => {
      urls.push(input.toString());
      return Promise.resolve(
        urls.length === 1
          ? Response.json({ auth: { issuer: "http://127.0.0.1:9000/realms/r" } })
          : Response.json({ access_token: "t" }),
      );
    },
  });

  expect(accessToken).toStrictEqual("t");
  expect(urls).toStrictEqual([
    "http://127.0.0.1:8080/.well-known",
    "http://127.0.0.1:9000/realms/r/protocol/openid-connect/token",
  ]);
});

test("generateAccessToken rejects an issuer that is not a valid URL without echoing it", async () => {
  let calls = 0;
  const error = await generateAccessToken({
    ...credentials,
    fetcher: () => {
      calls++;
      return Promise.resolve(Response.json({ auth: { issuer: "not a url" } }));
    },
  }).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toStrictEqual(
    "Authentication issuer in well-known configuration is not a valid URL",
  );
  expect((error as Error).cause).toBeInstanceOf(TypeError);
  expect(calls).toStrictEqual(1);
});
