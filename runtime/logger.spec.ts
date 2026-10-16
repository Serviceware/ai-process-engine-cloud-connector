import { expect, test } from "vitest";
import { createLogger, createReloadableLogger, isLogLevel } from "./logger.ts";

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
