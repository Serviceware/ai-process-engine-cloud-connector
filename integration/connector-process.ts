import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "./wait.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const probeUrl = "http://127.0.0.1:8080";
const readinessTimeoutMs = 20_000;
const exitTimeoutMs = 20_000;
const proxyVariable = /^(?:https?|all|no)_proxy$/i;

export type ConnectorExit = {
  code: number | null;
  output: string;
};

export type ConnectorProcessOptions = {
  env: Record<string, string>;
  config: string;
};

export class ConnectorProcess {
  readonly configPath: string;
  readonly exited: Promise<ConnectorExit>;
  private readonly directory: string;
  private readonly child: ChildProcess;
  private running = true;

  private constructor(
    directory: string,
    configPath: string,
    child: ChildProcess,
  ) {
    this.directory = directory;
    this.configPath = configPath;
    this.child = child;
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    this.exited = once(child, "close").then(([code]) => {
      this.running = false;
      return { code: code as number | null, output };
    });
  }

  static async start(
    options: ConnectorProcessOptions,
  ): Promise<ConnectorProcess> {
    const directory = await mkdtemp(join(tmpdir(), "cloud-connector-"));
    const configPath = join(directory, "cloud-connector.yml");
    await writeFile(configPath, options.config);

    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${repositoryRoot}`,
        `--allow-fs-read=${directory}`,
        "runtime/main.ts",
        configPath,
      ],
      {
        cwd: repositoryRoot,
        env: { ...inheritedEnvironment(), ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return new ConnectorProcess(directory, configPath, child);
  }

  /** Replaces the YAML file atomically, like a projected volume update. */
  async writeConfig(config: string): Promise<void> {
    const next = join(this.directory, "cloud-connector.yml.next");
    await writeFile(next, config);
    await rename(next, this.configPath);
  }

  async ready(): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${probeUrl}/ready`);
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  async waitUntilReady(): Promise<void> {
    await waitFor(
      async () => {
        if (!this.running) {
          const { code } = await this.exited;
          throw new Error(`Cloud Connector exited with ${code}`);
        }
        try {
          return (await this.ready()).status === 200 ? true : undefined;
        } catch {
          return undefined;
        }
      },
      "Cloud Connector readiness",
      readinessTimeoutMs,
    );
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<ConnectorExit> {
    if (this.running) this.child.kill(signal);
    return await this.waitForExit();
  }

  async waitForExit(): Promise<ConnectorExit> {
    await waitFor(
      () => (this.running ? undefined : true),
      "Cloud Connector exit",
      exitTimeoutMs,
    );
    return await this.exited;
  }

  async close(): Promise<void> {
    if (this.running) this.child.kill("SIGKILL");
    await this.exited;
    await rm(this.directory, { recursive: true });
  }
}

/** Keeps toolchain variables but never leaks connector or proxy settings. */
function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith("CLOUD_CONNECTOR_") &&
        !proxyVariable.test(entry[0]),
    ),
  );
}
