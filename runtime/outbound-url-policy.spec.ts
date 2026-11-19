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

test("OutboundUrlAllowlist denies userinfo, trailing-dot, and scheme tricks against anchored patterns", () => {
  const allowlist = new OutboundUrlAllowlist(["^https://allowed[.]example(?:/|$)"]);

  expect(allowlist.allows("https://allowed.example@evil.example/")).toStrictEqual(false);
  expect(allowlist.allows("https://allowed.example:443@evil.example/")).toStrictEqual(false);
  expect(allowlist.allows("https://allowed.example.:8443/")).toStrictEqual(false);
  expect(allowlist.allows("http://allowed.example/")).toStrictEqual(false);
  expect(allowlist.allows("https://allowed.example:443/path")).toStrictEqual(true);
});

test("OutboundUrlAllowlist normalizes IPv6 and IPv4 spellings before matching", () => {
  const allowlist = new OutboundUrlAllowlist(["^http://\\[::1\\](?::\\d+)?(?:/|$)", "^http://127[.]0[.]0[.]1(?:/|$)"]);

  expect(allowlist.allows("http://[0:0:0:0:0:0:0:1]/")).toStrictEqual(true);
  expect(allowlist.allows("http://0x7f.1/")).toStrictEqual(true);
  expect(allowlist.allows("http://2130706433/")).toStrictEqual(true);
  expect(allowlist.allows("http://[::ffff:127.0.0.1]/")).toStrictEqual(false);
  expect(allowlist.allows("http://localhost/")).toStrictEqual(false);
});

test("OutboundUrlAllowlist.assertAllows returns the parsed URL when allowed", () => {
  const allowlist = new OutboundUrlAllowlist(["^https://allowed[.]example(?:/|$)"]);
  const url = allowlist.assertAllows("https://ALLOWED.example/a?b=c");

  expect(url).toBeInstanceOf(URL);
  expect(url.href).toStrictEqual("https://allowed.example/a?b=c");
});

test("OutboundUrlAllowlist.assertAllows accepts URL instances and returns the same one", () => {
  const allowlist = new OutboundUrlAllowlist(["^https://allowed[.]example(?:/|$)"]);
  const url = new URL("https://allowed.example/x");

  expect(allowlist.assertAllows(url)).toBe(url);
});

test("OutboundUrlAllowlist.assertAllows hides query, fragment and credentials in the error", () => {
  const allowlist = new OutboundUrlAllowlist([]);

  expect(() => allowlist.assertAllows("https://user:pw@blocked.example:8443/p?token=hidden#frag")).toThrow(
    expect.objectContaining({
      name: "RuntimeError",
      code: "OUTBOUND_URL_NOT_ALLOWED",
      message: "Outbound URL is not allowed by forwarding target rules: https://blocked.example:8443/p",
    }),
  );
});

test("OutboundUrlAllowlist.assertAllows reports only the protocol for opaque origins", () => {
  const allowlist = new OutboundUrlAllowlist([]);

  expect(() => allowlist.assertAllows("data:text/plain,secret-payload")).toThrow(
    expect.objectContaining({
      code: "OUTBOUND_URL_NOT_ALLOWED",
      message: "Outbound URL is not allowed by forwarding target rules: data:",
    }),
  );
});

test("OutboundUrlAllowlist accepts URL instances", () => {
  const allowlist = new OutboundUrlAllowlist(["^https://allowed[.]example(?:/|$)"]);

  expect(allowlist.allows(new URL("https://allowed.example/x"))).toStrictEqual(true);
  expect(allowlist.allows(new URL("https://other.example/x"))).toStrictEqual(false);
});

test("allowlisted fetch always asks the next fetch not to follow redirects itself", async () => {
  const inits: Array<RequestInit | undefined> = [];
  const fetcher = createAllowlistedFetch([".*"], ((_input, init) => {
    inits.push(init);
    return Promise.resolve(new Response("ok"));
  }) as Fetcher);

  await fetcher("https://allowed.example/", { redirect: "follow" });

  expect(inits).toStrictEqual([{ redirect: "manual" }]);
});

test("allowlisted fetch returns redirect responses without a location header", async () => {
  let calls = 0;
  const fetcher = createAllowlistedFetch([".*"], (() => {
    calls += 1;
    return Promise.resolve(new Response("no location", { status: 302 }));
  }) as Fetcher);

  const response = await fetcher("https://allowed.example/");

  expect(response.status).toStrictEqual(302);
  expect(await response.text()).toStrictEqual("no location");
  expect(calls).toStrictEqual(1);
});

test("allowlisted fetch returns the redirect response in manual mode without checking the target", async () => {
  const calls: string[] = [];
  const fetcher = createAllowlistedFetch(["^https://allowed[.]example(?:/|$)"], ((input) => {
    calls.push(input instanceof Request ? input.url : input.toString());
    return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://blocked.example/" } }));
  }) as Fetcher);

  const response = await fetcher("https://allowed.example/start", { redirect: "manual" });

  expect(response.status).toStrictEqual(302);
  expect(response.headers.get("location")).toStrictEqual("https://blocked.example/");
  expect(calls).toStrictEqual(["https://allowed.example/start"]);
});

test("allowlisted fetch rejects redirects in error mode without following them", async () => {
  const calls: string[] = [];
  const fetcher = createAllowlistedFetch([".*"], ((input) => {
    calls.push(input instanceof Request ? input.url : input.toString());
    return Promise.resolve(new Response(null, { status: 301, headers: { location: "https://allowed.example/next" } }));
  }) as Fetcher);

  await expect(fetcher("https://allowed.example/start", { redirect: "error" })).rejects.toThrow(
    new TypeError("Redirect encountered while redirect mode is error"),
  );
  expect(calls).toStrictEqual(["https://allowed.example/start"]);
});

test("allowlisted fetch cancels the redirect response body before following", async () => {
  let cancelled = false;
  let calls = 0;
  const fetcher = createAllowlistedFetch([".*"], (() => {
    calls += 1;
    if (calls > 1) {
      return Promise.resolve(new Response("done"));
    }
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    return Promise.resolve(new Response(body, { status: 302, headers: { location: "/next" } }));
  }) as Fetcher);

  await fetcher("https://allowed.example/start");

  expect(cancelled).toStrictEqual(true);
});

test("allowlisted fetch follows up to 20 redirects and fails on the 21st", async () => {
  const calls: string[] = [];
  const fetcher = createAllowlistedFetch([".*"], ((input) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    return Promise.resolve(new Response(null, { status: 302, headers: { location: `/hop-${calls.length}` } }));
  }) as Fetcher);

  await expect(fetcher("https://allowed.example/start")).rejects.toThrow(
    new TypeError("Too many redirects (maximum 20)"),
  );
  expect(calls.length).toStrictEqual(21);
});

test("allowlisted fetch succeeds when the 20th redirect lands on a final response", async () => {
  let calls = 0;
  const fetcher = createAllowlistedFetch([".*"], (() => {
    calls += 1;
    return Promise.resolve(
      calls <= 20 ? new Response(null, { status: 302, headers: { location: `/hop-${calls}` } }) : new Response("done"),
    );
  }) as Fetcher);

  expect(await (await fetcher("https://allowed.example/start")).text()).toStrictEqual("done");
  expect(calls).toStrictEqual(21);
});

test("allowlisted fetch denies a protocol-relative redirect to a blocked host", async () => {
  const calls: string[] = [];
  const fetcher = createAllowlistedFetch(["^https://allowed[.]example(?:/|$)"], ((input) => {
    calls.push(input instanceof Request ? input.url : input.toString());
    return Promise.resolve(new Response(null, { status: 302, headers: { location: "//blocked.example/x" } }));
  }) as Fetcher);

  await expect(fetcher("https://allowed.example/start")).rejects.toThrow(
    expect.objectContaining({ code: "OUTBOUND_URL_NOT_ALLOWED" }),
  );
  expect(calls).toStrictEqual(["https://allowed.example/start"]);
});

test("allowlisted fetch keeps credentials on same-origin redirects", async () => {
  const calls: Request[] = [];
  const fetcher = createAllowlistedFetch([".*"], ((input) => {
    const request = input instanceof Request ? input : new Request(input);
    calls.push(request);
    return Promise.resolve(
      calls.length === 1 ? new Response(null, { status: 307, headers: { location: "/next" } }) : new Response("done"),
    );
  }) as Fetcher);

  await fetcher("https://allowed.example/start", {
    headers: { authorization: "Bearer secret", cookie: "a=b" },
  });

  expect(calls[1].headers.get("authorization")).toStrictEqual("Bearer secret");
  expect(calls[1].headers.get("cookie")).toStrictEqual("a=b");
});

test("allowlisted fetch strips credentials on port and scheme changes, even on 307", async () => {
  for (const target of ["https://allowed.example:8443/next", "http://allowed.example/next"]) {
    const calls: Request[] = [];
    const fetcher = createAllowlistedFetch([".*"], ((input) => {
      const request = input instanceof Request ? input : new Request(input);
      calls.push(request);
      return Promise.resolve(
        calls.length === 1 ? new Response(null, { status: 307, headers: { location: target } }) : new Response("done"),
      );
    }) as Fetcher);

    await fetcher("https://allowed.example/start", {
      method: "POST",
      body: "payload",
      headers: {
        authorization: "Bearer secret",
        cookie: "a=b",
        "proxy-authorization": "Basic x",
        "x-custom": "kept",
      },
    });

    expect(calls[1].url).toStrictEqual(target);
    expect(calls[1].method).toStrictEqual("POST");
    expect(calls[1].headers.get("authorization")).toStrictEqual(null);
    expect(calls[1].headers.get("cookie")).toStrictEqual(null);
    expect(calls[1].headers.get("proxy-authorization")).toStrictEqual(null);
    expect(calls[1].headers.get("x-custom")).toStrictEqual("kept");
  }
});

test("allowlisted fetch switches POST to GET on 301 and 302 but keeps other methods", async () => {
  const cases: Array<[number, string, string]> = [
    [301, "POST", "GET"],
    [302, "POST", "GET"],
    [301, "PUT", "PUT"],
    [302, "DELETE", "DELETE"],
    [303, "PUT", "GET"],
    [303, "HEAD", "HEAD"],
  ];
  for (const [status, method, expected] of cases) {
    const calls: Request[] = [];
    const fetcher = createAllowlistedFetch([".*"], ((input) => {
      const request = input instanceof Request ? input : new Request(input);
      calls.push(request);
      return Promise.resolve(
        calls.length === 1 ? new Response(null, { status, headers: { location: "/next" } }) : new Response("done"),
      );
    }) as Fetcher);

    await fetcher("https://allowed.example/start", { method, ...(method === "HEAD" ? {} : { body: "payload" }) });

    expect(calls[1].method).toStrictEqual(expected);
  }
});

test("allowlisted fetch drops body and content headers when a redirect switches to GET", async () => {
  const calls: Request[] = [];
  const fetcher = createAllowlistedFetch([".*"], ((input) => {
    const request = input instanceof Request ? input : new Request(input);
    calls.push(request);
    return Promise.resolve(
      calls.length === 1 ? new Response(null, { status: 302, headers: { location: "/next" } }) : new Response("done"),
    );
  }) as Fetcher);

  await fetcher("https://allowed.example/start", {
    method: "POST",
    body: "payload",
    headers: { "content-type": "text/plain", "x-custom": "kept" },
  });

  expect(calls[1].body).toStrictEqual(null);
  expect(calls[1].headers.get("content-type")).toStrictEqual(null);
  expect(calls[1].headers.get("content-length")).toStrictEqual(null);
  expect(calls[1].headers.get("x-custom")).toStrictEqual("kept");
});

test("allowlisted fetch ignores redirect statuses it does not follow", async () => {
  let calls = 0;
  const fetcher = createAllowlistedFetch([".*"], (() => {
    calls += 1;
    return Promise.resolve(new Response(null, { status: 300, headers: { location: "https://blocked.example/" } }));
  }) as Fetcher);

  const response = await fetcher("https://allowed.example/");

  expect(response.status).toStrictEqual(300);
  expect(calls).toStrictEqual(1);
});

test("allowlisted fetch rejects non-matching Request objects before calling the next fetch", async () => {
  let calls = 0;
  const fetcher = createAllowlistedFetch(["^https://allowed[.]example(?:/|$)"], (() => {
    calls += 1;
    return Promise.resolve(new Response("unexpected"));
  }) as Fetcher);

  await expect(fetcher(new Request("https://blocked.example/"))).rejects.toThrow(
    expect.objectContaining({ code: "OUTBOUND_URL_NOT_ALLOWED" }),
  );
  expect(calls).toStrictEqual(0);
});
