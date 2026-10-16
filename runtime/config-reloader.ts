import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  combineConfig,
  type ConnectorConfig,
  type EnvironmentConfig,
  loadVolumeConfig,
} from "./config.ts";
import type { RuntimeLogger } from "./logger.ts";
import type { RuntimeStatus } from "./runtime-status.ts";

export type ActivateConfig = (config: ConnectorConfig) => void | Promise<void>;

/**
 * Loads and validates a complete candidate before handing it to the runtime.
 * A failed read, parse, validation, or activation leaves the last-known-good
 * runtime state untouched.
 */
export class ConfigReloader {
  private readonly path: string;
  private readonly environment: EnvironmentConfig;
  private readonly activate: ActivateConfig;
  private readonly logger: RuntimeLogger;
  private readonly status?: RuntimeStatus;

  constructor(
    path: string,
    environment: EnvironmentConfig,
    activate: ActivateConfig,
    logger: RuntimeLogger,
    status?: RuntimeStatus,
  ) {
    this.path = path;
    this.environment = environment;
    this.activate = activate;
    this.logger = logger;
    this.status = status;
  }

  async reload(): Promise<boolean> {
    try {
      const volume = await loadVolumeConfig(this.path);
      const config = combineConfig(this.environment, volume);
      await this.activate(config);
      if (this.status) {
        this.status.lastReloadAt = Date.now();
        this.status.lastReloadSucceeded = true;
      }
      this.logger.info(`Hot-reloaded Cloud Connector config from ${this.path}`);
      return true;
    } catch (error) {
      if (this.status) {
        this.status.lastReloadAt = Date.now();
        this.status.lastReloadSucceeded = false;
      }
      this.logger.error(
        `Rejected Cloud Connector config update from ${this.path}; keeping the last-known-good configuration`,
        error,
      );
      return false;
    }
  }
}

/**
 * Watches the containing directory instead of the file itself so atomic file
 * replacements and projected-volume symlink updates are observed as well.
 */
export async function watchConfigFile(
  path: string,
  reloader: ConfigReloader,
  signal: AbortSignal,
  debounceMs = 100,
  pollIntervalMs = 1_000,
): Promise<void> {
  const watcher = watch(dirname(resolve(path)), { recursive: false });
  const wake: Wake = {};
  let changed = false;
  let watchError: unknown;
  watcher.on("change", () => {
    changed = true;
    wake.notify?.();
  });
  watcher.on("error", (error) => {
    watchError = error;
    wake.notify?.();
  });
  let lastContent: string | undefined;
  try {
    lastContent = await readFile(path, "utf8");
  } catch {
    // Startup already validated the file; a concurrent replacement is retried.
  }

  try {
    while (!signal.aborted) {
      if (!changed && watchError === undefined) {
        await abortableDelay(pollIntervalMs, signal, wake);
      }
      if (watchError !== undefined) throw watchError;
      if (signal.aborted) break;
      if (changed) {
        changed = false;
        await abortableDelay(debounceMs, signal);
      }
      if (signal.aborted) break;

      let content: string | undefined;
      try {
        content = await readFile(path, "utf8");
      } catch {
        // Let the reloader produce the actionable error and retain live state.
      }
      if (content === lastContent) continue;
      lastContent = content;
      await reloader.reload();
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    watcher.close();
  }
}

/** Lets a watcher event end the current poll delay early. */
type Wake = { notify?: () => void };

function abortableDelay(
  ms: number,
  signal: AbortSignal,
  wake?: Wake,
): Promise<void> {
  return new Promise((resolveDelay) => {
    if (signal.aborted) {
      resolveDelay();
      return;
    }
    const timeout = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (wake) wake.notify = done;

    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      if (wake) wake.notify = undefined;
      resolveDelay();
    }
  });
}
