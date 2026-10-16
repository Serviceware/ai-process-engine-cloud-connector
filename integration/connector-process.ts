import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { waitFor } from "./wait.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const probeUrl = "http://127.0.0.1:8080";
const readinessTimeoutMs = 20_000;
const exitTimeoutMs = 20_000;
const proxyVariable = /^(?:https?|all|no)_proxy$/i;
const configFileName = "cloud-connector.yml";

/** Runs the suite against this Docker image instead of `runtime/main.ts`. */
const integrationImage = process.env.INTEGRATION_TEST_IMAGE || undefined;

export type ConnectorExit = {
  code: number | null;
  output: string;
};

export type ConnectorProcessOptions = {
  env: Record<string, string>;
  config: string;
};

/**
 * Runs `runtime/main.ts` as a separate process with the production
 * permissions, a temporary YAML file, and an isolated environment. With
 * `INTEGRATION_TEST_IMAGE` set, runs that image the way customers do instead:
 * host network, the directory mounted read-only at `/config`, the image's own
 * command, and signals sent through `docker kill`.
 */
export class ConnectorProcess {
  readonly configPath: string;
  readonly exited: Promise<ConnectorExit>;
  private readonly directory: string;
  private readonly child: ChildProcess;
  private readonly container: string | undefined;
  private running = true;
  private output = "";

  private constructor(directory: string, configPath: string, child: ChildProcess, container: string | undefined) {
    this.directory = directory;
    this.configPath = configPath;
    this.child = child;
    this.container = container;
    child.stdout?.setEncoding("utf8").on("data", (chunk) => (this.output += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk) => (this.output += chunk));
    this.exited = once(child, "close").then(([code]) => {
      this.running = false;
      return { code: code as number | null, output: this.output };
    });
  }

  static async start(options: ConnectorProcessOptions): Promise<ConnectorProcess> {
    const directory = await mkdtemp(join(tmpdir(), "cloud-connector-"));
    const configPath = join(directory, configFileName);
    await writeFile(configPath, options.config);

    if (integrationImage === undefined) {
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
      return new ConnectorProcess(directory, configPath, child, undefined);
    }

    if (process.platform !== "linux") {
      throw new Error(
        `INTEGRATION_TEST_IMAGE=${integrationImage} needs Linux: the stubs on 127.0.0.1 are reachable only through --network host`,
      );
    }
    // The image runs as uid 1000; mkdtemp creates the directory as 0700.
    await chmod(directory, 0o755);
    const container = `cloud-connector-integration-${randomUUID()}`;
    // `docker run` stays attached, so its exit code is the container's.
    // Values travel through the client environment, not the command line.
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--pull=never",
        `--name=${container}`,
        "--network=host",
        `--volume=${directory}:/config:ro`,
        ...Object.keys(options.env).map((name) => `--env=${name}`),
        integrationImage,
      ],
      {
        env: { ...inheritedEnvironment(), ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return new ConnectorProcess(directory, configPath, child, container);
  }

  /** Replaces the YAML file atomically, like a projected volume update. */
  async writeConfig(config: string): Promise<void> {
    const next = join(this.directory, `${configFileName}.next`);
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

  async waitForOutput(text: string): Promise<void> {
    await waitFor(() => (this.output.includes(text) ? true : undefined), `Cloud Connector output "${text}"`).catch(
      (error: unknown) => {
        throw new Error(`${String(error)}\nOutput so far:\n${this.output}`, { cause: error });
      },
    );
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<ConnectorExit> {
    if (this.running) await this.kill(signal);
    return await this.waitForExit();
  }

  async waitForExit(): Promise<ConnectorExit> {
    await waitFor(() => (this.running ? undefined : true), "Cloud Connector exit", exitTimeoutMs);
    return await this.exited;
  }

  async close(): Promise<void> {
    if (this.running) await this.kill("SIGKILL");
    await this.exited;
    await rm(this.directory, { recursive: true });
  }

  private async kill(signal: NodeJS.Signals): Promise<void> {
    if (this.container === undefined) {
      this.child.kill(signal);
      return;
    }
    try {
      await promisify(execFile)("docker", ["kill", `--signal=${signal}`, this.container]);
    } catch (error) {
      // The container may have exited between the check and the kill.
      const exitedMeanwhile = await Promise.race([
        this.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(resolve, 1_000, false)),
      ]);
      if (!exitedMeanwhile) {
        throw new Error(`docker kill --signal=${signal} ${this.container}`, { cause: error });
      }
    }
  }
}

/** Keeps toolchain variables but never leaks connector or proxy settings. */
function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("CLOUD_CONNECTOR_") && !proxyVariable.test(entry[0]),
    ),
  );
}
