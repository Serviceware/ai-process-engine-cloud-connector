import { fromFileUrl, join } from "@std/path";
import { waitFor } from "./wait.ts";

const repositoryRoot = fromFileUrl(new URL("..", import.meta.url));
const probeUrl = "http://127.0.0.1:8080";
const readinessTimeoutMs = 20_000;
const exitTimeoutMs = 20_000;
const proxyVariable = /^(?:https?|all|no)_proxy$/i;

export type ConnectorExit = {
  code: number;
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
  private readonly child: Deno.ChildProcess;
  private running = true;

  private constructor(
    directory: string,
    configPath: string,
    child: Deno.ChildProcess,
  ) {
    this.directory = directory;
    this.configPath = configPath;
    this.child = child;
    this.exited = child.output().then((result) => {
      this.running = false;
      const decoder = new TextDecoder();
      return {
        code: result.code,
        output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
      };
    });
  }

  static async start(
    options: ConnectorProcessOptions,
  ): Promise<ConnectorProcess> {
    const directory = await Deno.makeTempDir({ prefix: "cloud-connector-" });
    const configPath = join(directory, "cloud-connector.yml");
    await Deno.writeTextFile(configPath, options.config);

    const child = new Deno.Command("deno", {
      args: [
        "run",
        "--frozen",
        "--allow-net",
        "--allow-env",
        "--allow-read",
        "runtime/main.ts",
        configPath,
      ],
      cwd: repositoryRoot,
      clearEnv: true,
      env: { ...inheritedEnvironment(), ...options.env },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    return new ConnectorProcess(directory, configPath, child);
  }

  /** Replaces the YAML file atomically, like a projected volume update. */
  async writeConfig(config: string): Promise<void> {
    const next = join(this.directory, "cloud-connector.yml.next");
    await Deno.writeTextFile(next, config);
    await Deno.rename(next, this.configPath);
  }

  async ready(): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${probeUrl}/ready`);
    return { status: response.status, body: await response.json() };
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

  async stop(signal: Deno.Signal = "SIGTERM"): Promise<ConnectorExit> {
    this.kill(signal);
    return await this.waitForExit();
  }

  async waitForExit(): Promise<ConnectorExit> {
    await waitFor(
      () => this.running ? undefined : true,
      "Cloud Connector exit",
      exitTimeoutMs,
    );
    return await this.exited;
  }

  async close(): Promise<void> {
    this.kill("SIGKILL");
    await this.exited;
    await Deno.remove(this.directory, { recursive: true });
  }

  private kill(signal: Deno.Signal): void {
    if (!this.running) return;
    try {
      this.child.kill(signal);
    } catch (error) {
      // Exited between the check and the kill.
      if (!(error instanceof TypeError)) throw error;
    }
  }
}

/** Keeps toolchain variables but never leaks connector or proxy settings. */
function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([name]) =>
      !name.startsWith("CLOUD_CONNECTOR_") && !proxyVariable.test(name)
    ),
  );
}
