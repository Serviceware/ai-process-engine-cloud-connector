import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { bumpVersion, parseChangeset } from "./changeset.ts";

const changesetScript = fileURLToPath(new URL("./changeset.ts", import.meta.url));
const execFileAsync = promisify(execFile);
const packageJson = '{\n  "name": "@serviceware/cloud-connector",\n  "version": "1.2.3"\n}\n';
const changelog = "# Changelog\n\n## 1.2.3 - 2026-09-14\n";
const emptyChangeset = "---\n---\n";

test("parses release and empty changesets", () => {
  expect(parseChangeset('---\n"@serviceware/cloud-connector": minor\n---\n\nAdd a feature.\n')).toStrictEqual({
    bump: "minor",
    summary: "Add a feature.",
  });
  expect(parseChangeset("---\n---\n")).toStrictEqual({ summary: "" });
});

test("parses quoting variants and CRLF line endings", () => {
  expect(parseChangeset("---\r\n'@serviceware/cloud-connector': patch\r\n---\r\n\r\nFix retry.\r\n")).toStrictEqual({
    bump: "patch",
    summary: "Fix retry.",
  });
  expect(parseChangeset("---\n@serviceware/cloud-connector: major\n---\nBreak config.\n")).toStrictEqual({
    bump: "major",
    summary: "Break config.",
  });
});

test("rejects malformed changesets", () => {
  expect(() => parseChangeset("No front matter")).toThrow("must contain YAML-style front matter");
  expect(() => parseChangeset('---\n"@serviceware/cloud-connector": major\n---\n')).toThrow(
    "must include a user-facing summary",
  );
});

test("rejects changesets with a bad bump, another package, or several bumps", () => {
  expect(() => parseChangeset('---\n"@serviceware/cloud-connector": huge\n---\n\nText.\n', ".changeset/x.md")).toThrow(
    '.changeset/x.md must use "@serviceware/cloud-connector": patch, minor, or major',
  );
  expect(() => parseChangeset('---\n"@serviceware/other": patch\n---\n\nText.\n')).toThrow(
    'changeset must use "@serviceware/cloud-connector"',
  );
  expect(() =>
    parseChangeset('---\n"@serviceware/cloud-connector": patch\n"@serviceware/cloud-connector": minor\n---\n\nText.\n'),
  ).toThrow("must describe exactly one Cloud Connector bump");
});

test("rejects empty front matter that still has a summary", () => {
  expect(() => parseChangeset("---\n---\n\nStray text.\n", ".changeset/y.md")).toThrow(
    ".changeset/y.md is empty but still contains a summary",
  );
});

test("bumps semantic versions", () => {
  expect(bumpVersion("1.0.0", "patch")).toStrictEqual("1.0.1");
  expect(bumpVersion("1.2.3", "minor")).toStrictEqual("1.3.0");
  expect(bumpVersion("0.8.7", "major")).toStrictEqual("1.0.0");
  expect(() => bumpVersion("v1.0.0", "patch")).toThrow("Version must use MAJOR.MINOR.PATCH");
});

test("rejects versions that are not MAJOR.MINOR.PATCH", () => {
  expect(() => bumpVersion("1.2", "minor")).toThrow("Version must use MAJOR.MINOR.PATCH, got 1.2");
  expect(() => bumpVersion("1.2.3-rc.1", "patch")).toThrow("Version must use MAJOR.MINOR.PATCH, got 1.2.3-rc.1");
});

test("changeset add fails clearly when standard input is closed", async () => {
  const child = spawn(process.execPath, ["scripts/changeset.ts", "add"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

  const [code] = await once(child, "close");

  expect(code).toStrictEqual(1);
  expect(stderr).toContain("Standard input closed before answering");
});

test("changeset add --empty writes an empty changeset without prompting", async () => {
  await withWorkspace(async (root) => {
    const result = await runChangeset(root, ["add", "--empty"]);

    expect(result.code).toStrictEqual(0);
    expect(result.stdout).toMatch(/^Created \.changeset\/[0-9a-f]{8}\.md\n$/);
    const created = await changesetFiles(root);
    expect(created).toHaveLength(1);
    expect(await readFile(join(root, ".changeset", created[0]), "utf8")).toStrictEqual("---\n\n---\n");
  });
});

test("changeset add writes a release changeset from the answers", async () => {
  await withWorkspace(async (root) => {
    const result = await runChangeset(root, ["add"], ["MINOR", "  Add export.  "]);

    expect(result.code).toStrictEqual(0);
    const created = await changesetFiles(root);
    expect(created).toHaveLength(1);
    expect(await readFile(join(root, ".changeset", created[0]), "utf8")).toStrictEqual(
      '---\n"@serviceware/cloud-connector": minor\n---\n\nAdd export.\n',
    );
  });
});

test("changeset add defaults the release impact to patch", async () => {
  await withWorkspace(async (root) => {
    const result = await runChangeset(root, ["add"], ["", "Fix retry."]);

    expect(result.code).toStrictEqual(0);
    const created = await changesetFiles(root);
    expect(await readFile(join(root, ".changeset", created[0]), "utf8")).toStrictEqual(
      '---\n"@serviceware/cloud-connector": patch\n---\n\nFix retry.\n',
    );
  });
});

test("changeset add rejects an unknown release impact and writes nothing", async () => {
  await withWorkspace(async (root) => {
    const result = await runChangeset(root, ["add"], ["huge"]);

    expect(result.code).toStrictEqual(1);
    expect(result.stderr).toContain("Release impact must be patch, minor, or major");
    expect(await changesetFiles(root)).toStrictEqual([]);
  });
});

test("changeset add requires a non-blank summary", async () => {
  await withWorkspace(async (root) => {
    const result = await runChangeset(root, ["add"], ["minor", "   "]);

    expect(result.code).toStrictEqual(1);
    expect(result.stderr).toContain("A user-facing summary is required");
    expect(await changesetFiles(root)).toStrictEqual([]);
  });
});

test("changeset status accepts changesets added since the given ref", async () => {
  await withRepository(async (root, base) => {
    await writeChangeset(root, "a1b2c3d4.md", '---\n"@serviceware/cloud-connector": patch\n---\n\nFix retry.\n');
    await writeChangeset(root, "e5f6a7b8.md", emptyChangeset);
    await commitAll(root, "Add changesets");

    const result = await runChangeset(root, ["status", `--since=${base}`]);

    expect(result.code).toStrictEqual(0);
    expect(result.stdout).toStrictEqual(`Validated 2 Changeset(s) since ${base}\n`);
  });
});

test("changeset status ignores README and fails when no changeset was added", async () => {
  await withRepository(async (root, base) => {
    await writeFile(join(root, ".changeset", "README.md"), "# Changesets\n\nUpdated.\n");
    await commitAll(root, "Edit README");

    const result = await runChangeset(root, ["status", `--since=${base}`]);

    expect(result.code).toStrictEqual(1);
    expect(result.stderr).toContain(`No release or empty Changeset found since ${base}`);
  });
});

test("changeset status ignores changesets deleted since the ref", async () => {
  await withRepository(async (root) => {
    await writeChangeset(root, "a1b2c3d4.md", emptyChangeset);
    await commitAll(root, "Add changeset");
    const base = await git(root, ["rev-parse", "HEAD"]);
    await rm(join(root, ".changeset", "a1b2c3d4.md"));
    await commitAll(root, "Remove changeset");

    const result = await runChangeset(root, ["status", `--since=${base}`]);

    expect(result.code).toStrictEqual(1);
    expect(result.stderr).toContain(`No release or empty Changeset found since ${base}`);
  });
});

test("changeset status reports the path of an invalid changeset", async () => {
  await withRepository(async (root, base) => {
    await writeChangeset(root, "bad.md", '---\n"@serviceware/cloud-connector": huge\n---\n\nText.\n');
    await commitAll(root, "Add invalid changeset");

    const result = await runChangeset(root, ["status", `--since=${base}`]);

    expect(result.code).toStrictEqual(1);
    expect(result.stderr).toContain('.changeset/bad.md must use "@serviceware/cloud-connector"');
  });
});

test("changeset status compares against origin/main by default", async () => {
  await withRepository(async (root) => {
    const result = await runChangeset(root, ["status"]);

    expect(result.code).toStrictEqual(1);
    expect(result.stderr).toContain("git diff --name-only --diff-filter=AMRT origin/main...HEAD");
    expect(result.stderr).toContain("failed");
  });
});

test("changeset version consumes changesets and prepares the highest release", async () => {
  await withWorkspace(async (root) => {
    await writeChangeset(
      root,
      "a.md",
      '---\n"@serviceware/cloud-connector": major\n---\n\nDrop legacy config.\n\nSee migration notes.\n',
    );
    await writeChangeset(root, "b.md", '---\n"@serviceware/cloud-connector": minor\n---\n\nAdd export.\n');
    await writeChangeset(root, "c.md", '---\n"@serviceware/cloud-connector": patch\n---\n\nFix retry.\n');

    const result = await runChangeset(root, ["version"]);

    expect(result.code).toStrictEqual(0);
    expect(result.stdout).toStrictEqual("Prepared Cloud Connector 2.0.0\n");
    expect(await readFile(join(root, "package.json"), "utf8")).toStrictEqual(
      '{\n  "name": "@serviceware/cloud-connector",\n  "version": "2.0.0"\n}\n',
    );
    const updatedChangelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    expect(updatedChangelog.replace(/\d{4}-\d{2}-\d{2}/, "<date>")).toStrictEqual(
      [
        "# Changelog",
        "",
        "## 2.0.0 - <date>",
        "",
        "### Major changes",
        "",
        "- Drop legacy config. See migration notes.",
        "",
        "### Added",
        "",
        "- Add export.",
        "",
        "### Fixed",
        "",
        "- Fix retry.",
        "",
        "## 1.2.3 - 2026-09-14",
        "",
      ].join("\n"),
    );
    expect(await changesetFiles(root)).toStrictEqual([]);
  });
});

test("changeset version without a release only consumes empty changesets", async () => {
  await withWorkspace(async (root) => {
    await writeChangeset(root, "a.md", emptyChangeset);

    const result = await runChangeset(root, ["version"]);

    expect(result.code).toStrictEqual(0);
    expect(result.stdout).toStrictEqual("Consumed empty Changesets without changing version\n");
    expect(await readFile(join(root, "package.json"), "utf8")).toStrictEqual(packageJson);
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toStrictEqual(changelog);
    expect(await changesetFiles(root)).toStrictEqual([]);
  });
});

test("changeset version reports when there is nothing pending", async () => {
  await withWorkspace(async (root) => {
    const result = await runChangeset(root, ["version"]);

    expect(result.code).toStrictEqual(0);
    expect(result.stdout).toStrictEqual("No pending Changesets\n");
    expect(await readFile(join(root, "package.json"), "utf8")).toStrictEqual(packageJson);
  });
});

test("changeset version stops before writing when a pending changeset is invalid", async () => {
  await withWorkspace(async (root) => {
    await writeChangeset(root, "a.md", '---\n"@serviceware/cloud-connector": minor\n---\n\nAdd export.\n');
    await writeChangeset(root, "bad.md", "No front matter\n");

    const result = await runChangeset(root, ["version"]);

    expect(result.code).toStrictEqual(1);
    expect(result.stderr).toContain("bad.md must contain YAML-style front matter");
    expect(await readFile(join(root, "package.json"), "utf8")).toStrictEqual(packageJson);
    expect(await changesetFiles(root)).toStrictEqual(["a.md", "bad.md"]);
  });
});

test("changeset version requires a string package version", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "package.json"), '{"name":"@serviceware/cloud-connector"}\n');
    await writeChangeset(root, "a.md", '---\n"@serviceware/cloud-connector": patch\n---\n\nFix retry.\n');

    const result = await runChangeset(root, ["version"]);

    expect(result.code).toStrictEqual(1);
    expect(result.stderr).toContain("package.json must contain a string version");
  });
});

test("changeset version requires an existing release in the changelog", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n");
    await writeChangeset(root, "a.md", '---\n"@serviceware/cloud-connector": patch\n---\n\nFix retry.\n');

    const result = await runChangeset(root, ["version"]);

    expect(result.code).toStrictEqual(1);
    expect(result.stderr).toContain("CHANGELOG.md must contain an existing release");
  });
});

test("changeset prints usage for an unknown command", async () => {
  await withWorkspace(async (root) => {
    const result = await runChangeset(root, []);

    expect(result.code).toStrictEqual(1);
    expect(result.stderr).toContain("Usage: changeset.ts add [--empty] | status [--since=REF] | version");
  });
});

type RunResult = { code: number | null; stdout: string; stderr: string };

async function runChangeset(cwd: string, args: string[], answers: string[] = []): Promise<RunResult> {
  const child = spawn(process.execPath, [changesetScript, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
  let stdout = "";
  let stderr = "";
  let answered = 0;
  let answeredAt = -1;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    // One answer per prompt: piped lines that arrive before a question is asked are dropped.
    if (answered < answers.length && stdout.endsWith(": ") && stdout.length !== answeredAt) {
      answeredAt = stdout.length;
      child.stdin.write(`${answers[answered++]}\n`);
      if (answered === answers.length) child.stdin.end();
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  if (answers.length === 0) child.stdin.end();

  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cloud-connector-changeset-"));
  try {
    await mkdir(join(root, ".changeset"));
    await writeFile(join(root, "package.json"), packageJson);
    await writeFile(join(root, "CHANGELOG.md"), changelog);
    await writeFile(join(root, ".changeset", "README.md"), "# Changesets\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withRepository(run: (root: string, base: string) => Promise<void>): Promise<void> {
  await withWorkspace(async (root) => {
    await git(root, ["init", "--quiet"]);
    await commitAll(root, "Base");
    await run(root, await git(root, ["rev-parse", "HEAD"]));
  });
}

async function writeChangeset(root: string, name: string, content: string): Promise<void> {
  await writeFile(join(root, ".changeset", name), content);
}

async function changesetFiles(root: string): Promise<string[]> {
  return (await readdir(join(root, ".changeset"))).filter((name) => name !== "README.md").sort();
}

async function commitAll(root: string, message: string): Promise<void> {
  await git(root, ["add", "--all"]);
  await git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--message",
    message,
  ]);
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout.trim();
}
