import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
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
