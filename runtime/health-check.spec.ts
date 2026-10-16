import { expect, test } from "vitest";
import { checkHealth } from "./health-check.ts";

test("checkHealth returns success for healthy responses", async () => {
  const exitCode = await checkHealth(9090, (input) => {
    expect(input).toStrictEqual("http://localhost:9090/health");
    return Promise.resolve(new Response("ok", { status: 200 }));
  });

  expect(exitCode).toStrictEqual(0);
});

test("checkHealth returns failure for unhealthy responses and fetch errors", async () => {
  expect(await checkHealth(9090, () => Promise.resolve(new Response("down", { status: 503 })))).toStrictEqual(1);
  expect(await checkHealth(9090, () => Promise.reject(new Error("offline")))).toStrictEqual(1);
});
