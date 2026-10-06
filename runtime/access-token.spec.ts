import { assertEquals, assertRejects } from "@std/assert";
import { generateAccessToken } from "./access-token.ts";

Deno.test("generateAccessToken resolves issuer and requests a client credentials token", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ url, init });

      if (url === "https://cloud.example/.well-known") {
        return Promise.resolve(Response.json({
          auth: { issuer: "https://cloud.example/realms/serviceware" },
        }));
      }

      if (
        url ===
          "https://cloud.example/realms/serviceware/protocol/openid-connect/token"
      ) {
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

    assertEquals(accessToken, "access-token");
    assertEquals(calls.length, 2);
    assertEquals(calls[0].url, "https://cloud.example/.well-known");
    assertEquals(
      calls[1].url,
      "https://cloud.example/realms/serviceware/protocol/openid-connect/token",
    );
    assertEquals(calls[1].init?.method, "POST");
    assertEquals(calls[1].init?.redirect, "error");
    assertEquals(calls[1].init?.headers, {
      "Content-Type": "application/x-www-form-urlencoded",
    });

    const body = calls[1].init?.body as URLSearchParams;
    assertEquals(body.get("grant_type"), "client_credentials");
    assertEquals(body.get("client_id"), "client-id");
    assertEquals(body.get("client_secret"), "client-secret");
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  }
});

Deno.test("generateAccessToken rejects token responses without access token", async () => {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://cloud.example/.well-known") {
        return Promise.resolve(Response.json({
          auth: { issuer: "https://cloud.example/realms/serviceware" },
        }));
      }

      return Promise.resolve(Response.json({}));
    },
  });

  try {
    await assertRejects(
      () =>
        generateAccessToken({
          host: "https://cloud.example/",
          clientId: "client-id",
          clientSecret: "client-secret",
        }),
      Error,
      "Access token not found in token response.",
    );
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  }
});

Deno.test("generateAccessToken accepts the issuer returned by the Cloud context", async () => {
  const calls: string[] = [];
  const accessToken = await generateAccessToken({
    host: "https://cloud.example/",
    clientId: "client-id",
    clientSecret: "client-secret",
    fetcher: (input) => {
      const url = input.toString();
      calls.push(url);
      if (url === "https://cloud.example/.well-known") {
        return Promise.resolve(Response.json({
          auth: {
            issuer: "https://identity.customer.example/realms/serviceware",
          },
        }));
      }
      return Promise.resolve(Response.json({ access_token: "access-token" }));
    },
  });

  assertEquals(accessToken, "access-token");
  assertEquals(calls, [
    "https://cloud.example/.well-known",
    "https://identity.customer.example/realms/serviceware/protocol/openid-connect/token",
  ]);
});

Deno.test("generateAccessToken rejects malformed issuer URLs before sending credentials", async () => {
  for (
    const issuer of [
      "https://user:password@sso.swop.cloud/realms/serviceware",
      "https://sso.swop.cloud/realms/serviceware?next=attacker",
      "https://sso.swop.cloud/realms/serviceware#fragment",
    ]
  ) {
    let calls = 0;
    await assertRejects(
      () =>
        generateAccessToken({
          host: "https://cloud.example/",
          clientId: "client-id",
          clientSecret: "client-secret",
          fetcher: () => {
            calls++;
            return Promise.resolve(Response.json({ auth: { issuer } }));
          },
        }),
      Error,
      "must not contain credentials, query parameters, or a fragment",
    );
    assertEquals(calls, 1);
  }
});
