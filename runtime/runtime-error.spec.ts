import { expect, test } from "vitest";
import { RuntimeError, toCloudConnectorError } from "./runtime-error.ts";

test("toCloudConnectorError preserves RuntimeError codes", () => {
  expect(
    toCloudConnectorError(new RuntimeError("HOOK_REJECTED", "Rejected")),
  ).toStrictEqual({
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
