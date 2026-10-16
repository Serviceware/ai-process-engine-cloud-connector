import { fromFileUrl, join } from "@std/path";
import { waitFor } from "./wait.ts";

const repositoryRoot = fromFileUrl(new URL("..", import.meta.url));
const probeUrl = "http://127.0.0.1:8080";

export type ConnectorExit = {
  code: number;
  output: string;
};

export type ConnectorProcessOptions = {
  env: Record<string, string>;
  config: string;
};

/**
 * Runs `runtime/main.ts` as a separate process with the production
 * permissions, a temporary YAML file, and an isolated environment.
 */
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

  async waitUntilReady(timeoutMs = 20_000): Promise<void> {
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
      timeoutMs,
    );
  }

  async stop(signal: Deno.Signal = "SIGTERM"): Promise<ConnectorExit> {
    if (this.running) this.child.kill(signal);
    return await this.exited;
  }

  async close(): Promise<void> {
    if (this.running) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // Exited between the check and the kill.
      }
    }
    await this.exited;
    await Deno.remove(this.directory, { recursive: true });
  }
}

/** Keeps toolchain variables but never leaks ambient connector settings. */
function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([name]) =>
      !name.startsWith("CLOUD_CONNECTOR_")
    ),
  );
}
