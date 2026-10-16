import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline/promises";
import { promisify } from "node:util";

export type Bump = "patch" | "minor" | "major";

export type Changeset = {
  bump?: Bump;
  summary: string;
};

const packageName = "@serviceware/cloud-connector";
const changesetDirectory = ".changeset";
const releaseOrder: Record<Bump, number> = {
  patch: 0,
  minor: 1,
  major: 2,
};

export function parseChangeset(content: string, path = "changeset"): Changeset {
  const match = content.match(/^---\r?\n([\s\S]*?)---(?:\r?\n([\s\S]*))?$/);
  if (!match) {
    throw new Error(`${path} must contain YAML-style front matter`);
  }

  const metadata = match[1].trim();
  const summary = (match[2] ?? "").trim();
  if (metadata === "") {
    if (summary !== "") {
      throw new Error(`${path} is empty but still contains a summary`);
    }
    return { summary: "" };
  }

  const lines = metadata.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length !== 1) {
    throw new Error(`${path} must describe exactly one Cloud Connector bump`);
  }

  const release = lines[0].match(
    /^(?:"@serviceware\/cloud-connector"|'@serviceware\/cloud-connector'|@serviceware\/cloud-connector):\s*(patch|minor|major)$/,
  );
  if (!release) {
    throw new Error(`${path} must use "${packageName}": patch, minor, or major`);
  }
  if (summary === "") {
    throw new Error(`${path} must include a user-facing summary`);
  }

  return { bump: release[1] as Bump, summary };
}

export function bumpVersion(version: string, bump: Bump): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Version must use MAJOR.MINOR.PATCH, got ${version}`);
  }

  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function listChangesetPaths(): Promise<string[]> {
  const paths: string[] = [];
  const entries = await readdir(changesetDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
      paths.push(`${changesetDirectory}/${entry.name}`);
    }
  }
  return paths.sort();
}

async function readChangesets(paths: string[]): Promise<Changeset[]> {
  return await Promise.all(paths.map(async (path) => parseChangeset(await readFile(path, "utf8"), path)));
}

async function addChangeset(args: string[]): Promise<void> {
  const empty = args.includes("--empty");
  let content = "---\n\n---\n";

  if (!empty) {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const selected =
        (await ask(readline, "Release impact (patch, minor, or major) [patch]: ")).trim().toLowerCase() || "patch";
      if (selected !== "patch" && selected !== "minor" && selected !== "major") {
        throw new Error("Release impact must be patch, minor, or major");
      }
      const summary = (await ask(readline, "User-facing summary: ")).trim();
      if (!summary) throw new Error("A user-facing summary is required");
      content = `---\n"${packageName}": ${selected}\n---\n\n${summary}\n`;
    } finally {
      readline.close();
    }
  }

  const path = `${changesetDirectory}/${randomUUID().slice(0, 8)}.md`;
  await writeFile(path, content, { flag: "wx" });
  console.log(`Created ${path}`);
}

/** `question()` never settles once stdin has ended. */
async function ask(readline: Interface, query: string): Promise<string> {
  const closed = new Promise<undefined>((resolve) => readline.once("close", () => resolve(undefined)));
  const answer = await Promise.race([readline.question(query), closed]);
  if (answer === undefined) {
    throw new Error(`Standard input closed before answering "${query.trim()}"; run interactively or pass --empty`);
  }
  return answer;
}

async function runGit(args: string[]): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)("git", args);
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args.join(" ")} failed: ${stderr || error}`, {
      cause: error,
    });
  }
}

async function validateStatus(args: string[]): Promise<void> {
  const sinceArgument = args.find((argument) => argument.startsWith("--since="));
  const since = sinceArgument?.slice("--since=".length) ?? "origin/main";
  const changedFiles = (
    await runGit(["diff", "--name-only", "--diff-filter=AMRT", `${since}...HEAD`, "--", changesetDirectory])
  )
    .split("\n")
    .filter(Boolean);
  const paths = changedFiles.filter(
    (path) =>
      path.startsWith(`${changesetDirectory}/`) && path.endsWith(".md") && path !== `${changesetDirectory}/README.md`,
  );
  if (paths.length === 0) {
    throw new Error(`No release or empty Changeset found since ${since}`);
  }

  await readChangesets(paths);
  console.log(`Validated ${paths.length} Changeset(s) since ${since}`);
}

function selectBump(changesets: Changeset[]): Bump | undefined {
  return changesets.reduce<Bump | undefined>((selected, changeset) => {
    if (!changeset.bump) return selected;
    if (!selected || releaseOrder[changeset.bump] > releaseOrder[selected]) {
      return changeset.bump;
    }
    return selected;
  }, undefined);
}

function renderRelease(version: string, changesets: Changeset[]): string {
  const sections: Array<[Bump, string]> = [
    ["major", "Major changes"],
    ["minor", "Added"],
    ["patch", "Fixed"],
  ];
  const body = sections.flatMap(([bump, heading]) => {
    const entries = changesets.filter((changeset) => changeset.bump === bump);
    if (entries.length === 0) return [];
    return [`### ${heading}`, "", ...entries.map((entry) => `- ${entry.summary.replace(/\s+/g, " ")}`), ""];
  });
  const date = new Date().toISOString().slice(0, 10);
  return [`## ${version} - ${date}`, "", ...body].join("\n").trimEnd();
}

async function versionRelease(): Promise<void> {
  const paths = await listChangesetPaths();
  if (paths.length === 0) {
    console.log("No pending Changesets");
    return;
  }

  const changesets = await readChangesets(paths);
  const bump = selectBump(changesets);
  if (bump) {
    const packageJson = await readJson("package.json");
    if (typeof packageJson.version !== "string") {
      throw new Error("package.json must contain a string version");
    }
    const version = bumpVersion(packageJson.version, bump);
    packageJson.version = version;
    await writeJson("package.json", packageJson);

    const changelogPath = "CHANGELOG.md";
    const changelog = await readFile(changelogPath, "utf8");
    const releaseIndex = changelog.indexOf("\n## ");
    if (releaseIndex === -1) {
      throw new Error(`${changelogPath} must contain an existing release`);
    }
    const release = renderRelease(version, changesets);
    const preamble = changelog.slice(0, releaseIndex).trimEnd();
    const existingReleases = changelog.slice(releaseIndex).trim();
    const updated = `${preamble}\n\n${release}\n\n${existingReleases}\n`;
    await writeFile(changelogPath, updated);
    console.log(`Prepared Cloud Connector ${version}`);
  } else {
    console.log("Consumed empty Changesets without changing version");
  }

  await Promise.all(paths.map((path) => unlink(path)));
}

type JsonObject = Record<string, unknown>;

async function readJson(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

async function writeJson(path: string, value: JsonObject): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "add") return await addChangeset(args);
  if (command === "status") return await validateStatus(args);
  if (command === "version") return await versionRelease();
  throw new Error("Usage: changeset.ts add [--empty] | status [--since=REF] | version");
}

if (import.meta.main) await main();
