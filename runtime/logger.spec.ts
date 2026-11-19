import { expect, test } from "vitest";
import { createLogger, createReloadableLogger, defaultLogLevel, isLogLevel } from "./logger.ts";

function recordingSink() {
  const entries: string[] = [];
  return {
    entries,
    sink: {
      error: (...data: unknown[]) => entries.push(`error:${data.join(" ")}`),
      warn: (...data: unknown[]) => entries.push(`warn:${data.join(" ")}`),
      info: (...data: unknown[]) => entries.push(`info:${data.join(" ")}`),
      debug: (...data: unknown[]) => entries.push(`debug:${data.join(" ")}`),
    },
  };
}

test("isLogLevel accepts supported log levels only", () => {
  expect(isLogLevel("error")).toStrictEqual(true);
  expect(isLogLevel("warn")).toStrictEqual(true);
  expect(isLogLevel("info")).toStrictEqual(true);
  expect(isLogLevel("debug")).toStrictEqual(true);
  expect(isLogLevel("trace")).toStrictEqual(false);
});

test("createReloadableLogger applies a new YAML level immediately", () => {
  const entries: string[] = [];
  const sink = {
    error: (...data: unknown[]) => entries.push(`error:${data.join(" ")}`),
    warn: (...data: unknown[]) => entries.push(`warn:${data.join(" ")}`),
    info: (...data: unknown[]) => entries.push(`info:${data.join(" ")}`),
    debug: (...data: unknown[]) => entries.push(`debug:${data.join(" ")}`),
  };
  const logger = createReloadableLogger("error", sink);

  logger.info("hidden");
  logger.setLevel("debug");
  logger.info("visible");

  expect(logger.level()).toStrictEqual("debug");
  expect(entries).toStrictEqual(["info:[cloud-connector] INFO visible"]);
});

test("createLogger filters messages by level", () => {
  const entries: string[] = [];
  const sink = {
    error: (...data: unknown[]) => entries.push(`error:${data.join(" ")}`),
    warn: (...data: unknown[]) => entries.push(`warn:${data.join(" ")}`),
    info: (...data: unknown[]) => entries.push(`info:${data.join(" ")}`),
    debug: (...data: unknown[]) => entries.push(`debug:${data.join(" ")}`),
  };

  const logger = createLogger("warn", sink);
  logger.error("boom");
  logger.warn("careful");
  logger.info("hidden");
  logger.debug("hidden");

  expect(entries).toStrictEqual(["error:[cloud-connector] ERROR boom", "warn:[cloud-connector] WARN careful"]);
});

test("createLogger at debug level passes every level to its sink", () => {
  const { entries, sink } = recordingSink();
  const logger = createLogger("debug", sink);

  logger.error("e");
  logger.warn("w");
  logger.info("i");
  logger.debug("d");

  expect(entries).toStrictEqual([
    "error:[cloud-connector] ERROR e",
    "warn:[cloud-connector] WARN w",
    "info:[cloud-connector] INFO i",
    "debug:[cloud-connector] DEBUG d",
  ]);
});

test("createLogger defaults to info, hiding debug messages", () => {
  expect(defaultLogLevel).toStrictEqual("info");
  const { entries, sink } = recordingSink();
  const logger = createLogger(undefined, sink);

  logger.info("shown");
  logger.debug("hidden");

  expect(entries).toStrictEqual(["info:[cloud-connector] INFO shown"]);
});

test("createLogger keeps error output at the error level", () => {
  const { entries, sink } = recordingSink();
  const logger = createLogger("error", sink);

  logger.error("boom");
  logger.warn("hidden");

  expect(entries).toStrictEqual(["error:[cloud-connector] ERROR boom"]);
});

test("createLogger passes error objects to the sink unchanged", () => {
  const sinkArguments: unknown[][] = [];
  const failure = new Error("connect failed");
  const logger = createLogger("error", {
    debug: () => undefined,
    error: (...data) => sinkArguments.push(data),
    info: () => undefined,
    warn: () => undefined,
  });

  logger.error("request failed", failure);

  expect(sinkArguments).toHaveLength(1);
  expect(sinkArguments[0][2]).toBe(failure);
});

test("createReloadableLogger always reports errors", () => {
  const { entries, sink } = recordingSink();
  const logger = createReloadableLogger("error", sink);

  logger.error("boom");
  logger.warn("hidden");

  expect(entries).toStrictEqual(["error:[cloud-connector] ERROR boom"]);
});

test("createReloadableLogger filters each level against its current threshold", () => {
  const { entries, sink } = recordingSink();
  const logger = createReloadableLogger("warn", sink);

  logger.warn("w1");
  logger.info("hidden");
  logger.debug("hidden");
  logger.setLevel("debug");
  logger.debug("d1");
  logger.setLevel("info");
  logger.debug("hidden");
  logger.info("i1");

  expect(entries).toStrictEqual([
    "warn:[cloud-connector] WARN w1",
    "debug:[cloud-connector] DEBUG d1",
    "info:[cloud-connector] INFO i1",
  ]);
});

test("createReloadableLogger defaults to info", () => {
  const logger = createReloadableLogger();

  expect(logger.level()).toStrictEqual("info");
});
