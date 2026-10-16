import { expect, test } from "vitest";
import { describeError, RuntimeError, toCloudConnectorError } from "./runtime-error.ts";

test("toCloudConnectorError preserves RuntimeError codes", () => {
  expect(toCloudConnectorError(new RuntimeError("HOOK_REJECTED", "Rejected"))).toStrictEqual({
    code: "HOOK_REJECTED",
    message: "Rejected",
  });
});

test("toCloudConnectorError normalizes unexpected errors", () => {
  expect(toCloudConnectorError(new Error("Boom"))).toStrictEqual({
    code: "UNEXPECTED_ERROR",
    message: "Boom",
  });
  expect(toCloudConnectorError("plain failure")).toStrictEqual({
    code: "UNEXPECTED_ERROR",
    message: "plain failure",
  });
});

test("describeError names cause codes without their addresses", () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:1"), {
    code: "ECONNREFUSED",
  });
  expect(describeError(new TypeError("fetch failed", { cause: refused }))).toStrictEqual("fetch failed (ECONNREFUSED)");
  expect(
    describeError(
      new TypeError("fetch failed", {
        cause: new AggregateError([refused, refused]),
      }),
    ),
  ).toStrictEqual("fetch failed (ECONNREFUSED)");
  expect(describeError(new Error("Boom"))).toStrictEqual("Boom");
  expect(describeError("plain failure")).toStrictEqual("plain failure");
});

test("describeError redacts URLs that can carry credentials", () => {
  expect(
    describeError(
      new TypeError(
        "Request cannot be constructed from a URL that includes credentials: https://user:secret@idp.internal/token",
      ),
    ),
  ).toStrictEqual("Request cannot be constructed from a URL that includes credentials: <url>");
});
