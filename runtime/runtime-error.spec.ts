import { expect, test } from "vitest";
import { describeError, RuntimeError, toCloudConnectorError } from "./runtime-error.ts";

test("toCloudConnectorError preserves RuntimeError codes", () => {
  expect(toCloudConnectorError(new RuntimeError("HOOK_REJECTED", "Rejected"))).toStrictEqual({
    code: "HOOK_REJECTED",
    message: "Rejected",
  });
});

test("RuntimeError carries its code, name and cause", () => {
  const inner = new Error("socket closed");
  const error = new RuntimeError("HOOK_REJECTED", "Rejected", { cause: inner });

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toStrictEqual("RuntimeError");
  expect(error.code).toStrictEqual("HOOK_REJECTED");
  expect(error.cause).toBe(inner);
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

test("describeError ignores codes that are not strings", () => {
  expect(describeError(Object.assign(new Error("Boom"), { code: 42 }))).toStrictEqual("Boom");
});

test("describeError follows cause chains up to five levels deep", () => {
  let error: Error = Object.assign(new Error("level 6"), { code: "E6" });
  for (let level = 5; level >= 1; level--) {
    error = Object.assign(new Error(`level ${level}`), { code: `E${level}`, cause: error });
  }

  expect(describeError(error)).toStrictEqual("level 1 (E1, E2, E3, E4, E5)");
});

test("describeError terminates on a cause that refers to itself", () => {
  const looping = Object.assign(new Error("loop"), { code: "ELOOP" });
  looping.cause = looping;

  expect(describeError(looping)).toStrictEqual("loop (ELOOP)");
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

test("describeError redacts every URL in the message", () => {
  expect(describeError(new Error("GET http://a.internal/x then ws://user:pw@b.internal failed"))).toStrictEqual(
    "GET <url> then <url> failed",
  );
});

test("describeError keeps messages without a URL scheme unchanged", () => {
  expect(describeError(new Error("host localhost:8080 not reachable"))).toStrictEqual(
    "host localhost:8080 not reachable",
  );
});
