import { expect, test, vi } from "vitest";
import { createRuntimeStatus } from "./runtime-status.ts";

test("createRuntimeStatus starts disconnected with no recorded events", () => {
  expect(createRuntimeStatus(1_000)).toStrictEqual({
    connectionState: "disconnected",
    lastConnectedAt: null,
    lastInboundAt: null,
    lastTickAt: 1_000,
    reconnectAttempt: 0,
    lastReloadAt: null,
    lastReloadSucceeded: null,
  });
});

test("createRuntimeStatus defaults the supervision tick to the current time", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(42_000);
  try {
    expect(createRuntimeStatus().lastTickAt).toStrictEqual(42_000);
  } finally {
    now.mockRestore();
  }
});

test("createRuntimeStatus returns a new object on every call", () => {
  const first = createRuntimeStatus(1_000);
  const second = createRuntimeStatus(1_000);

  first.connectionState = "open";

  expect(second.connectionState).toStrictEqual("disconnected");
});
