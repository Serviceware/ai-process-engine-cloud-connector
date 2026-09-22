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
  const match = content.match(
    /^---\r?\n([\s\S]*?)---(?:\r?\n([\s\S]*))?$/,
  );
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
    throw new Error(
      `${path} must use "${packageName}": patch, minor, or major`,
    );
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
  for await (const entry of Deno.readDir(changesetDirectory)) {
    if (
      entry.isFile && entry.name.endsWith(".md") && entry.name !== "README.md"
    ) {
      paths.push(`${changesetDirectory}/${entry.name}`);
    }
  }
  return paths.sort();
}

async function readChangesets(paths: string[]): Promise<Changeset[]> {
  return await Promise.all(
    paths.map(async (path) =>
      parseChangeset(await Deno.readTextFile(path), path)
    ),
  );
}

async function addChangeset(args: string[]): Promise<void> {
  const empty = args.includes("--empty");
  let content = "---\n\n---\n";

  if (!empty) {
    const selected = prompt("Release impact (patch, minor, or major):", "patch")
      ?.trim().toLowerCase();
    if (selected !== "patch" && selected !== "minor" && selected !== "major") {
      throw new Error("Release impact must be patch, minor, or major");
    }
    const summary = prompt("User-facing summary:")?.trim();
    if (!summary) throw new Error("A user-facing summary is required");
    content = `---\n"${packageName}": ${selected}\n---\n\n${summary}\n`;
  }

  const path = `${changesetDirectory}/${crypto.randomUUID().slice(0, 8)}.md`;
  await Deno.writeTextFile(path, content, { createNew: true });
  console.log(`Created ${path}`);
}

async function runGit(args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function validateStatus(args: string[]): Promise<void> {
  const sinceArgument = args.find((argument) =>
    argument.startsWith("--since=")
  );
  const since = sinceArgument?.slice("--since=".length) ?? "origin/main";
  const changedFiles = (await runGit([
    "diff",
    "--name-only",
    "--diff-filter=AMRT",
    `${since}...HEAD`,
    "--",
    changesetDirectory,
  ])).split("\n").filter(Boolean);
  const paths = changedFiles.filter((path) =>
    path.startsWith(`${changesetDirectory}/`) && path.endsWith(".md") &&
    path !== `${changesetDirectory}/README.md`
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
    return [
      `### ${heading}`,
      "",
      ...entries.map((entry) => `- ${entry.summary.replace(/\s+/g, " ")}`),
      "",
    ];
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
    const denoJson = JSON.parse(await Deno.readTextFile("deno.json"));
    if (typeof denoJson.version !== "string") {
      throw new Error("deno.json must contain a string version");
    }
    const version = bumpVersion(denoJson.version, bump);
    denoJson.version = version;
    await Deno.writeTextFile(
      "deno.json",
      `${JSON.stringify(denoJson, null, 2)}\n`,
    );

    const changelogPath = "CHANGELOG.md";
    const changelog = await Deno.readTextFile(changelogPath);
    const releaseIndex = changelog.indexOf("\n## ");
    if (releaseIndex === -1) {
      throw new Error(`${changelogPath} must contain an existing release`);
    }
    const release = renderRelease(version, changesets);
    const preamble = changelog.slice(0, releaseIndex).trimEnd();
    const existingReleases = changelog.slice(releaseIndex).trim();
    const updated = `${preamble}\n\n${release}\n\n${existingReleases}\n`;
    await Deno.writeTextFile(changelogPath, updated);
    console.log(`Prepared Cloud Connector ${version}`);
  } else {
    console.log("Consumed empty Changesets without changing version");
  }

  await Promise.all(paths.map((path) => Deno.remove(path)));
}

async function main(): Promise<void> {
  const [command, ...args] = Deno.args;
  if (command === "add") return await addChangeset(args);
  if (command === "status") return await validateStatus(args);
  if (command === "version") return await versionRelease();
  throw new Error(
    "Usage: changeset.ts add [--empty] | status [--since=REF] | version",
  );
}

if (import.meta.main) await main();
