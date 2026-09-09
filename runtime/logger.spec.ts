import { assertEquals } from "@std/assert";
import { createLogger, createReloadableLogger, isLogLevel } from "./logger.ts";

Deno.test("isLogLevel accepts supported log levels only", () => {
  assertEquals(isLogLevel("error"), true);
  assertEquals(isLogLevel("warn"), true);
  assertEquals(isLogLevel("info"), true);
  assertEquals(isLogLevel("debug"), true);
  assertEquals(isLogLevel("trace"), false);
});

Deno.test("createReloadableLogger applies a new YAML level immediately", () => {
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

  assertEquals(logger.level(), "debug");
  assertEquals(entries, ["info:[cloud-connector] INFO visible"]);
});

Deno.test("createLogger filters messages by level", () => {
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

  assertEquals(entries, [
    "error:[cloud-connector] ERROR boom",
    "warn:[cloud-connector] WARN careful",
  ]);
});
