import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ConfigReloader, watchConfigFile } from "./config-reloader.ts";
import { type ConnectorConfig, loadEnvironmentConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createRuntimeStatus } from "./runtime-status.ts";

const environment = loadEnvironmentConfig({
  CLOUD_CONNECTOR_HOST: "https://cloud.example",
  CLOUD_CONNECTOR_CLIENT_ID: "client-id",
  CLOUD_CONNECTOR_CLIENT_SECRET: "client-secret",
});

const silentLogger = createLogger("error", {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

function yaml(target: string, heartbeat = 30): string {
  return `
connection:
  heartbeatIntervalSeconds: ${heartbeat}
logging:
  level: debug
forwarding:
  - target: ^${target}(?:/.*)?$
`;
}

test("ConfigReloader activates complete valid snapshots only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-connector-"));
  const file = join(directory, "cloud-connector.yml");
  let active: ConnectorConfig | undefined;
  const status = createRuntimeStatus();
  const reloader = new ConfigReloader(
    file,
    environment,
    (candidate) => {
      active = candidate;
    },
    silentLogger,
    status,
  );

  try {
    await writeFile(file, yaml("https://internal.example"));
    expect(await reloader.reload()).toStrictEqual(true);
    expect(status.lastReloadSucceeded).toStrictEqual(true);
    expect(active?.forwarding[0].target).toStrictEqual("^https://internal.example(?:/.*)?$");

    await writeFile(file, "connection: [invalid");
    expect(await reloader.reload()).toStrictEqual(false);
    expect(status.lastReloadSucceeded).toStrictEqual(false);
    expect(typeof status.lastReloadAt).toStrictEqual("number");
    expect(active?.forwarding[0].target).toStrictEqual("^https://internal.example(?:/.*)?$");

    await writeFile(file, yaml("https://replacement.example", 200));
    expect(await reloader.reload()).toStrictEqual(false);
    expect(active?.forwarding[0].target).toStrictEqual("^https://internal.example(?:/.*)?$");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("watchConfigFile reloads an atomically replaced volume file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-connector-"));
  const file = `${directory}/cloud-connector.yml`;
  const replacement = `${directory}/cloud-connector.next.yml`;
  const abortController = new AbortController();
  let active: ConnectorConfig | undefined;
  let activations = 0;

  try {
    await writeFile(file, yaml("https://internal.example"));
    const reloader = new ConfigReloader(
      file,
      environment,
      (candidate) => {
        active = candidate;
        activations += 1;
      },
      silentLogger,
    );
    const watcher = watchConfigFile(file, reloader, abortController.signal, 5, 5);

    await delay(10);
    await writeFile(replacement, yaml("https://internal.example/v2"));
    await rename(replacement, file);
    await waitUntil(() => active?.forwarding[0].target === "^https://internal.example/v2(?:/.*)?$");
    expect(activations >= 1).toStrictEqual(true);
    expect(active?.forwarding[0].target).toStrictEqual("^https://internal.example/v2(?:/.*)?$");

    abortController.abort();
    await watcher;
  } finally {
    abortController.abort();
    await rm(directory, { recursive: true });
  }
});

test("ConfigReloader rejects a missing file, keeps live state and logs the path with the cause", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-connector-"));
  const file = join(directory, "cloud-connector.yml");
  const activate = vi.fn<(config: ConnectorConfig) => void>();
  const error = vi.fn<(...data: unknown[]) => void>();
  const status = createRuntimeStatus();
  const reloader = new ConfigReloader(file, environment, activate, { ...silentLogger, error }, status);

  try {
    expect(await reloader.reload()).toStrictEqual(false);
    expect(activate).not.toHaveBeenCalled();
    expect(status.lastReloadSucceeded).toStrictEqual(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain(file);
    expect(error.mock.calls[0][1]).toBeInstanceOf(Error);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("ConfigReloader treats an activation failure as a rejected update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-connector-"));
  const file = join(directory, "cloud-connector.yml");
  const cause = new Error("executor construction failed");
  const error = vi.fn<(...data: unknown[]) => void>();
  const info = vi.fn<(...data: unknown[]) => void>();
  const status = createRuntimeStatus();
  const reloader = new ConfigReloader(
    file,
    environment,
    () => {
      throw cause;
    },
    { ...silentLogger, error, info },
    status,
  );

  try {
    await writeFile(file, yaml("https://internal.example"));
    expect(await reloader.reload()).toStrictEqual(false);
    expect(status.lastReloadSucceeded).toStrictEqual(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("keeping the last-known-good"), cause);
    expect(info).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("ConfigReloader works without a status object and logs success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-connector-"));
  const file = join(directory, "cloud-connector.yml");
  const info = vi.fn<(...data: unknown[]) => void>();
  const reloader = new ConfigReloader(file, environment, () => undefined, { ...silentLogger, info });

  try {
    await writeFile(file, yaml("https://internal.example"));
    expect(await reloader.reload()).toStrictEqual(true);
    expect(info).toHaveBeenCalledWith(expect.stringContaining(file));
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("watchConfigFile coalesces rapid writes into one reload after the debounce", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-connector-"));
  const file = join(directory, "cloud-connector.yml");
  const abortController = new AbortController();
  const reload = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const reloader = { reload } as unknown as ConfigReloader;

  try {
    await writeFile(file, yaml("https://internal.example"));
    const watcher = watchConfigFile(file, reloader, abortController.signal, 300, 10_000);
    await delay(20);

    await writeFile(file, yaml("https://internal.example/a"));
    await writeFile(file, yaml("https://internal.example/b"));
    await writeFile(file, yaml("https://internal.example/c"));
    await waitUntil(() => reload.mock.calls.length > 0);
    await delay(400);

    expect(reload).toHaveBeenCalledTimes(1);

    abortController.abort();
    await watcher;
  } finally {
    abortController.abort();
    await rm(directory, { recursive: true });
  }
});

test("watchConfigFile skips rewrites with identical content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-connector-"));
  const file = join(directory, "cloud-connector.yml");
  const abortController = new AbortController();
  const reload = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const reloader = { reload } as unknown as ConfigReloader;

  try {
    await writeFile(file, yaml("https://internal.example"));
    const watcher = watchConfigFile(file, reloader, abortController.signal, 5, 5);
    await delay(20);

    await writeFile(file, yaml("https://internal.example"));
    await delay(100);

    expect(reload).not.toHaveBeenCalled();

    abortController.abort();
    await watcher;
  } finally {
    abortController.abort();
    await rm(directory, { recursive: true });
  }
});

test("watchConfigFile reports a deleted file once and recovers when it is restored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-connector-"));
  const file = join(directory, "cloud-connector.yml");
  const abortController = new AbortController();
  const activate = vi.fn<(config: ConnectorConfig) => void>();
  const status = createRuntimeStatus();
  const reloader = new ConfigReloader(file, environment, activate, silentLogger, status);
  const reload = vi.spyOn(reloader, "reload");

  try {
    await writeFile(file, yaml("https://internal.example"));
    const watcher = watchConfigFile(file, reloader, abortController.signal, 5, 5);
    await delay(20);

    await unlink(file);
    await waitUntil(() => reload.mock.calls.length === 1);
    await delay(100);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
    expect(status.lastReloadSucceeded).toStrictEqual(false);

    await writeFile(file, yaml("https://internal.example/restored"));
    await waitUntil(() => activate.mock.calls.length === 1);
    expect(status.lastReloadSucceeded).toStrictEqual(true);

    abortController.abort();
    await watcher;
  } finally {
    abortController.abort();
    await rm(directory, { recursive: true });
  }
});

test("watchConfigFile rejects when the watched directory does not exist", async () => {
  const reloader = { reload: vi.fn<() => Promise<boolean>>() } as unknown as ConfigReloader;

  await expect(
    watchConfigFile("/nonexistent-cloud-connector-dir/cloud-connector.yml", reloader, new AbortController().signal),
  ).rejects.toThrow(/ENOENT/);
});

test("watchConfigFile returns promptly when aborted while idle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-connector-"));
  const file = join(directory, "cloud-connector.yml");
  const abortController = new AbortController();
  const reload = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

  try {
    await writeFile(file, yaml("https://internal.example"));
    const watcher = watchConfigFile(file, { reload } as unknown as ConfigReloader, abortController.signal, 5, 60_000);
    await delay(20);
    abortController.abort();
    await watcher;
    expect(reload).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true });
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await delay(5);
  }
  throw new Error("Condition was not met in time");
}
