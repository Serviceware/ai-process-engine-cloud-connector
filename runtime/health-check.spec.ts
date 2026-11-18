import { expect, test } from "vitest";
import { checkHealth } from "./health-check.ts";

test("checkHealth returns success for healthy responses", async () => {
  const exitCode = await checkHealth(9090, (input) => {
    expect(input).toStrictEqual("http://localhost:9090/health");
    return Promise.resolve(new Response("ok", { status: 200 }));
  });

  expect(exitCode).toStrictEqual(0);
});

test("checkHealth probes port 8080 by default", async () => {
  const exitCode = await checkHealth(undefined, (input) => {
    expect(input).toStrictEqual("http://localhost:8080/health");
    return Promise.resolve(new Response(null, { status: 204 }));
  });

  expect(exitCode).toStrictEqual(0);
});

test("checkHealth returns failure for unhealthy responses and fetch errors", async () => {
  expect(await checkHealth(9090, () => Promise.resolve(new Response("down", { status: 503 })))).toStrictEqual(1);
  expect(await checkHealth(9090, () => Promise.reject(new Error("offline")))).toStrictEqual(1);
});

test("checkHealth logs the HTTP status of an unhealthy response", async () => {
  const errors = await captureConsoleErrors(() =>
    checkHealth(9090, () => Promise.resolve(new Response("down", { status: 503 }))),
  );

  expect(errors).toStrictEqual(["Health check failed: HTTP 503"]);
});

test("checkHealth logs the cause of a fetch failure with URLs redacted", async () => {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9090"), { code: "ECONNREFUSED" });
  const failure = Object.assign(new TypeError("fetch failed for http://user:pass@localhost:9090/health"), { cause });
  const errors = await captureConsoleErrors(() => checkHealth(9090, () => Promise.reject(failure)));

  expect(errors).toStrictEqual(["Health check failed: fetch failed for <url> (ECONNREFUSED)"]);
});

test("checkHealth treats only 2xx responses as healthy", async () => {
  expect(await checkHealth(9090, () => Promise.resolve(new Response(null, { status: 299 })))).toStrictEqual(0);
  expect(await checkHealth(9090, () => Promise.resolve(new Response(null, { status: 300 })))).toStrictEqual(1);
});

async function captureConsoleErrors(run: () => Promise<number>): Promise<unknown[]> {
  const original = console.error;
  const errors: unknown[] = [];
  console.error = (...data: unknown[]) => {
    errors.push(data.join(" "));
  };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return errors;
}
