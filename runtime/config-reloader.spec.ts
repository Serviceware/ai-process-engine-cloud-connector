import { assertEquals } from "@std/assert";
import { ConfigReloader, watchConfigFile } from "./config-reloader.ts";
import { type ConnectorConfig, loadEnvironmentConfig } from "./config.ts";
import { createLogger } from "./logger.ts";

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
  websocketUrl: wss://cloud.example/connector/ws
  heartbeatIntervalSeconds: ${heartbeat}
logging:
  level: debug
forwarding:
  target: ${target}
  outboundUrlAllowlist:
    - "^https://internal[.]example(?:/|$)"
`;
}

Deno.test("ConfigReloader activates complete valid snapshots only", async () => {
  const file = await Deno.makeTempFile({ suffix: ".yml" });
  let active: ConnectorConfig | undefined;
  const reloader = new ConfigReloader(
    file,
    environment,
    (candidate) => {
      active = candidate;
    },
    silentLogger,
  );

  try {
    await Deno.writeTextFile(file, yaml("https://internal.example"));
    assertEquals(await reloader.reload(), true);
    assertEquals(active?.forwarding.target, "https://internal.example");

    await Deno.writeTextFile(file, "connection: [invalid");
    assertEquals(await reloader.reload(), false);
    assertEquals(active?.forwarding.target, "https://internal.example");

    await Deno.writeTextFile(file, yaml("https://replacement.example", 200));
    assertEquals(await reloader.reload(), false);
    assertEquals(active?.forwarding.target, "https://internal.example");
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("watchConfigFile reloads an atomically replaced volume file", async () => {
  const directory = await Deno.makeTempDir();
  const file = `${directory}/cloud-connector.yml`;
  const replacement = `${directory}/cloud-connector.next.yml`;
  const abortController = new AbortController();
  let active: ConnectorConfig | undefined;
  let activations = 0;

  try {
    await Deno.writeTextFile(file, yaml("https://internal.example"));
    const reloader = new ConfigReloader(
      file,
      environment,
      (candidate) => {
        active = candidate;
        activations += 1;
      },
      silentLogger,
    );
    const watcher = watchConfigFile(
      file,
      reloader,
      abortController.signal,
      5,
      5,
    );

    await delay(10);
    await Deno.writeTextFile(replacement, yaml("https://internal.example/v2"));
    await Deno.rename(replacement, file);
    await waitUntil(
      () => active?.forwarding.target === "https://internal.example/v2",
    );
    assertEquals(activations >= 1, true);
    assertEquals(active?.forwarding.target, "https://internal.example/v2");

    abortController.abort();
    await watcher;
  } finally {
    abortController.abort();
    await Deno.remove(directory, { recursive: true });
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
