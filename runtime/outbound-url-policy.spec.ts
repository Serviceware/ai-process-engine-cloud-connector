import { expect, test } from "vitest";
import { createAllowlistedFetch, type Fetcher, OutboundUrlAllowlist } from "./outbound-url-policy.ts";

test("OutboundUrlAllowlist denies everything when empty", () => {
  const allowlist = new OutboundUrlAllowlist([]);
  expect(allowlist.allows("https://internal.example/orders")).toStrictEqual(false);
});

test("OutboundUrlAllowlist matches normalized URLs with configured regexes", () => {
  const allowlist = new OutboundUrlAllowlist(["^https://internal[.]example(?::8443)?(?:/|$)"]);

  expect(allowlist.allows("HTTPS://INTERNAL.EXAMPLE/orders")).toStrictEqual(true);
  expect(allowlist.allows("https://internal.example:8443/orders")).toStrictEqual(true);
  expect(allowlist.allows("https://internal.example.evil/orders")).toStrictEqual(false);
  expect(allowlist.allows("https://other.example/internal.example")).toStrictEqual(false);
});

test("OutboundUrlAllowlist supports an explicit match-all expression", () => {
  const allowlist = new OutboundUrlAllowlist([".*"]);
  expect(allowlist.allows("https://any.example/path")).toStrictEqual(true);
});

test("allowlisted fetch blocks before sending a request", async () => {
  let calls = 0;
  const fetcher = createAllowlistedFetch([], (() => {
    calls += 1;
    return Promise.resolve(new Response("unexpected"));
  }) as Fetcher);

  await expect(fetcher("https://blocked.example/secret?token=hidden")).rejects.toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("forwarding target rules"),
    }),
  );
  expect(calls).toStrictEqual(0);
});

test("allowlisted fetch permits matching requests", async () => {
  const calls: string[] = [];
  const fetcher = createAllowlistedFetch(["^https://allowed[.]example(?:/|$)"], ((input) => {
    calls.push(input instanceof Request ? input.url : input.toString());
    return Promise.resolve(new Response("ok"));
  }) as Fetcher);

  expect(await (await fetcher("https://allowed.example/path")).text()).toStrictEqual("ok");
  expect(calls).toStrictEqual(["https://allowed.example/path"]);
});

test("allowlisted fetch rechecks redirect targets", async () => {
  const calls: string[] = [];
  const fetcher = createAllowlistedFetch(["^https://allowed[.]example(?:/|$)"], ((input) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "https://blocked.example/private" },
      }),
    );
  }) as Fetcher);

  await expect(fetcher("https://allowed.example/start")).rejects.toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      message: expect.stringContaining("forwarding target rules"),
    }),
  );
  expect(calls).toStrictEqual(["https://allowed.example/start"]);
});

test("allowlisted fetch follows allowed redirects and strips credentials across origins", async () => {
  const calls: Request[] = [];
  const fetcher = createAllowlistedFetch(["^https://(?:first|second)[.]example(?:/|$)"], ((input) => {
    const request = input instanceof Request ? input : new Request(input);
    calls.push(request);
    if (calls.length === 1) {
      return Promise.resolve(
        new Response(null, {
          status: 303,
          headers: { location: "https://second.example/final" },
        }),
      );
    }
    return Promise.resolve(new Response("done"));
  }) as Fetcher);

  const response = await fetcher("https://first.example/start", {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
    },
    body: "{}",
  });

  expect(await response.text()).toStrictEqual("done");
  expect(calls.map((request) => request.url)).toStrictEqual([
    "https://first.example/start",
    "https://second.example/final",
  ]);
  expect(calls[1].method).toStrictEqual("GET");
  expect(calls[1].headers.get("authorization")).toStrictEqual(null);
  expect(calls[1].headers.get("content-type")).toStrictEqual(null);
});

test("allowlisted fetch preserves methods and bodies for 307 redirects", async () => {
  const calls: Request[] = [];
  const fetcher = createAllowlistedFetch(["^https://allowed[.]example(?:/|$)"], ((input) => {
    const request = input instanceof Request ? input : new Request(input);
    calls.push(request);
    if (calls.length === 1) {
      return Promise.resolve(
        new Response(null, {
          status: 307,
          headers: { location: "/next" },
        }),
      );
    }
    return Promise.resolve(new Response("done"));
  }) as Fetcher);

  await fetcher("https://allowed.example/start", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "payload",
  });

  expect(calls[1].url).toStrictEqual("https://allowed.example/next");
  expect(calls[1].method).toStrictEqual("POST");
  expect(await calls[1].text()).toStrictEqual("payload");
});
