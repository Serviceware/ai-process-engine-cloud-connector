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
