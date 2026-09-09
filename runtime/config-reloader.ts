import { dirname, resolve } from "@std/path";
import {
  combineConfig,
  type ConnectorConfig,
  type EnvironmentConfig,
  loadVolumeConfig,
} from "./config.ts";
import type { RuntimeLogger } from "./logger.ts";

export type ActivateConfig = (
  config: ConnectorConfig,
) => void | Promise<void>;

/**
 * Loads and validates a complete candidate before handing it to the runtime.
 * A failed read, parse, validation, or activation leaves the last-known-good
 * runtime state untouched.
 */
export class ConfigReloader {
  constructor(
    private readonly path: string,
    private readonly environment: EnvironmentConfig,
    private readonly activate: ActivateConfig,
    private readonly logger: RuntimeLogger,
  ) {}

  async reload(): Promise<boolean> {
    try {
      const volume = await loadVolumeConfig(this.path);
      const config = combineConfig(this.environment, volume);
      await this.activate(config);
      this.logger.info(`Hot-reloaded Cloud Connector config from ${this.path}`);
      return true;
    } catch (error) {
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
  const watcher = Deno.watchFs(dirname(resolve(path)), { recursive: false });
  const close = () => watcher.close();
  signal.addEventListener("abort", close, { once: true });
  const iterator = watcher[Symbol.asyncIterator]();
  let nextEvent = iterator.next();
  let lastContent: string | undefined;
  try {
    lastContent = await Deno.readTextFile(path);
  } catch {
    // Startup already validated the file; a concurrent replacement is retried.
  }

  try {
    while (!signal.aborted) {
      const result = await Promise.race([
        nextEvent.then(() => "event" as const),
        abortableDelay(pollIntervalMs, signal).then(() => "poll" as const),
      ]);
      if (signal.aborted) break;
      if (result === "event") {
        nextEvent = iterator.next();
        await abortableDelay(debounceMs, signal);
      }
      if (signal.aborted) break;

      let content: string | undefined;
      try {
        content = await Deno.readTextFile(path);
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
    signal.removeEventListener("abort", close);
    try {
      watcher.close();
    } catch {
      // Already closed by abort.
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    if (signal.aborted) {
      resolveDelay();
      return;
    }
    const timeout = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });

    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolveDelay();
    }
  });
}
