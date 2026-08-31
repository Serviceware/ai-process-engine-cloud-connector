import { assertEquals, assertRejects } from "@std/assert";
import {
  createAllowlistedFetch,
  installOutboundUrlPolicy,
  type Fetcher,
  OutboundUrlAllowlist,
} from "./outbound-url-policy.ts";
import { RuntimeError } from "./runtime-error.ts";

Deno.test("OutboundUrlAllowlist denies everything when empty", () => {
  const allowlist = new OutboundUrlAllowlist([]);
  assertEquals(allowlist.allows("https://internal.example/orders"), false);
});

Deno.test("OutboundUrlAllowlist matches normalized URLs with configured regexes", () => {
  const allowlist = new OutboundUrlAllowlist([
    "^https://internal[.]example(?::8443)?(?:/|$)",
  ]);

  assertEquals(allowlist.allows("HTTPS://INTERNAL.EXAMPLE/orders"), true);
  assertEquals(allowlist.allows("https://internal.example:8443/orders"), true);
  assertEquals(allowlist.allows("https://internal.example.evil/orders"), false);
  assertEquals(
    allowlist.allows("https://other.example/internal.example"),
    false,
  );
});

Deno.test("OutboundUrlAllowlist supports an explicit match-all expression", () => {
  const allowlist = new OutboundUrlAllowlist([".*"]);
  assertEquals(allowlist.allows("https://any.example/path"), true);
});

Deno.test("installed policy guards direct fetch calls", async () => {
  const restore = installOutboundUrlPolicy([]);
  try {
    await assertRejects(
      () => fetch("https://blocked.example/path"),
      RuntimeError,
      "OUTBOUND_URL_ALLOWLIST",
    );
  } finally {
    restore();
  }
});

Deno.test("allowlisted fetch blocks before sending a request", async () => {
  let calls = 0;
  const fetcher = createAllowlistedFetch(
    [],
    (() => {
      calls += 1;
      return Promise.resolve(new Response("unexpected"));
    }) as Fetcher,
  );

  await assertRejects(
    () => fetcher("https://blocked.example/secret?token=hidden"),
    RuntimeError,
    "OUTBOUND_URL_ALLOWLIST",
  );
  assertEquals(calls, 0);
});

Deno.test("allowlisted fetch permits matching requests", async () => {
  const calls: string[] = [];
  const fetcher = createAllowlistedFetch(
    ["^https://allowed[.]example(?:/|$)"],
    ((input) => {
      calls.push(input instanceof Request ? input.url : input.toString());
      return Promise.resolve(new Response("ok"));
    }) as Fetcher,
  );

  assertEquals(
    await (await fetcher("https://allowed.example/path")).text(),
    "ok",
  );
  assertEquals(calls, ["https://allowed.example/path"]);
});

Deno.test("allowlisted fetch rechecks redirect targets", async () => {
  const calls: string[] = [];
  const fetcher = createAllowlistedFetch(
    ["^https://allowed[.]example(?:/|$)"],
    ((input) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push(url);
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://blocked.example/private" },
        }),
      );
    }) as Fetcher,
  );

  await assertRejects(
    () => fetcher("https://allowed.example/start"),
    RuntimeError,
    "OUTBOUND_URL_ALLOWLIST",
  );
  assertEquals(calls, ["https://allowed.example/start"]);
});

Deno.test("allowlisted fetch follows allowed redirects and strips credentials across origins", async () => {
  const calls: Request[] = [];
  const fetcher = createAllowlistedFetch(
    ["^https://(?:first|second)[.]example(?:/|$)"],
    ((input) => {
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
    }) as Fetcher,
  );

  const response = await fetcher("https://first.example/start", {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
    },
    body: "{}",
  });

  assertEquals(await response.text(), "done");
  assertEquals(calls.map((request) => request.url), [
    "https://first.example/start",
    "https://second.example/final",
  ]);
  assertEquals(calls[1].method, "GET");
  assertEquals(calls[1].headers.get("authorization"), null);
  assertEquals(calls[1].headers.get("content-type"), null);
});

Deno.test("allowlisted fetch preserves methods and bodies for 307 redirects", async () => {
  const calls: Request[] = [];
  const fetcher = createAllowlistedFetch(
    ["^https://allowed[.]example(?:/|$)"],
    ((input) => {
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
    }) as Fetcher,
  );

  await fetcher("https://allowed.example/start", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "payload",
  });

  assertEquals(calls[1].url, "https://allowed.example/next");
  assertEquals(calls[1].method, "POST");
  assertEquals(await calls[1].text(), "payload");
});
