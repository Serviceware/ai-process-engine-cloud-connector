import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { syncReleaseArtifacts } from "./sync-release-artifacts.ts";

const syncScript = fileURLToPath(new URL("./sync-release-artifacts.ts", import.meta.url));

test("syncReleaseArtifacts checks and updates discovered release references", async () => {
  const root = await createFixture();
  try {
    expect(await syncReleaseArtifacts({ root, checkOnly: true })).toStrictEqual([]);

    await writeFile(`${root}/templates/starter.yml`, "image: ghcr.io/serviceware/cloud-connector:0.9.0\n");
    await expect(syncReleaseArtifacts({ root, checkOnly: true })).rejects.toThrow(
      "must reference ghcr.io/serviceware/cloud-connector:1.2.3",
    );

    await writeFile(`${root}/CHANGELOG.md`, "# Changelog\n\n## 1.2.3\n");
    expect(await syncReleaseArtifacts({ root, releaseDate: "2026-09-15" })).toStrictEqual([
      "templates/starter.yml",
      "CHANGELOG.md",
    ]);
    expect(await readFile(`${root}/templates/starter.yml`, "utf8")).toStrictEqual(
      "image: ghcr.io/serviceware/cloud-connector:1.2.3\n",
    );
    expect(await readFile(`${root}/CHANGELOG.md`, "utf8")).toStrictEqual("# Changelog\n\n## 1.2.3 - 2026-09-15\n");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("syncReleaseArtifacts enforces one image reference per maintained file", async () => {
  const root = await createFixture();
  try {
    await writeFile(
      `${root}/docs/images.md`,
      "ghcr.io/serviceware/cloud-connector:1.2.3\n" + "ghcr.io/serviceware/cloud-connector:0.9.0\n",
    );
    await expect(syncReleaseArtifacts({ root, checkOnly: true })).rejects.toThrow(
      "must contain exactly one Cloud Connector image",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("syncReleaseArtifacts check mode leaves stale references and headings unchanged", async () => {
  const root = await createFixture();
  try {
    await writeFile(`${root}/docs/guide.md`, "ghcr.io/serviceware/cloud-connector:0.9.0\n");
    await writeFile(`${root}/CHANGELOG.md`, "# Changelog\n\n## 1.2.3\n");

    await expect(syncReleaseArtifacts({ root, checkOnly: true })).rejects.toThrow(
      "docs/guide.md must reference ghcr.io/serviceware/cloud-connector:1.2.3",
    );
    expect(await readFile(`${root}/docs/guide.md`, "utf8")).toStrictEqual(
      "ghcr.io/serviceware/cloud-connector:0.9.0\n",
    );

    await writeFile(`${root}/docs/guide.md`, "ghcr.io/serviceware/cloud-connector:1.2.3\n");
    await expect(syncReleaseArtifacts({ root, checkOnly: true })).rejects.toThrow(
      "CHANGELOG.md has no dated 1.2.3 release heading",
    );
    expect(await readFile(`${root}/CHANGELOG.md`, "utf8")).toStrictEqual("# Changelog\n\n## 1.2.3\n");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("syncReleaseArtifacts fails when no changelog heading matches the package version", async () => {
  const root = await createFixture();
  try {
    await writeFile(`${root}/CHANGELOG.md`, "# Changelog\n\n## 1.2.2 - 2026-09-14\n");

    await expect(syncReleaseArtifacts({ root })).rejects.toThrow("CHANGELOG.md has no 1.2.3 release heading");
    expect(await readFile(`${root}/CHANGELOG.md`, "utf8")).toStrictEqual("# Changelog\n\n## 1.2.2 - 2026-09-14\n");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("syncReleaseArtifacts dates an undated heading with today when no release date is given", async () => {
  const root = await createFixture();
  try {
    await writeFile(`${root}/CHANGELOG.md`, "# Changelog\n\n## 1.2.3\n");

    expect(await syncReleaseArtifacts({ root })).toStrictEqual(["CHANGELOG.md"]);
    expect(await readFile(`${root}/CHANGELOG.md`, "utf8")).toMatch(/^# Changelog\n\n## 1\.2\.3 - \d{4}-\d{2}-\d{2}\n$/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("syncReleaseArtifacts matches the package version literally in changelog headings", async () => {
  const root = await createFixture();
  try {
    await writeFile(`${root}/CHANGELOG.md`, "# Changelog\n\n## 1x2x3 - 2026-09-14\n");

    await expect(syncReleaseArtifacts({ root, checkOnly: true })).rejects.toThrow(
      "CHANGELOG.md has no dated 1.2.3 release heading",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("syncReleaseArtifacts rejects package versions that are not MAJOR.MINOR.PATCH", async () => {
  const root = await createFixture();
  try {
    await writeFile(`${root}/package.json`, '{"version":"1.2.3-rc.1"}\n');
    await expect(syncReleaseArtifacts({ root })).rejects.toThrow(
      "package.json version must use MAJOR.MINOR.PATCH, got 1.2.3-rc.1",
    );

    await writeFile(`${root}/package.json`, '{"name":"cloud-connector"}\n');
    await expect(syncReleaseArtifacts({ root })).rejects.toThrow("package.json version must use MAJOR.MINOR.PATCH");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("syncReleaseArtifacts updates nested Markdown and YAML files under docs and templates only", async () => {
  const root = await createFixture();
  try {
    await mkdir(`${root}/docs/nested`, { recursive: true });
    await mkdir(`${root}/examples`, { recursive: true });
    await writeFile(`${root}/README.md`, "Use ghcr.io/serviceware/cloud-connector:0.9.0.\n");
    await writeFile(`${root}/docs/nested/guide.md`, "ghcr.io/serviceware/cloud-connector:0.9.0\n");
    await writeFile(`${root}/templates/compose.yaml`, "image: ghcr.io/serviceware/cloud-connector:0.9.0\n");
    await writeFile(`${root}/docs/notes.txt`, "ghcr.io/serviceware/cloud-connector:0.9.0\n");
    await writeFile(`${root}/examples/compose.yml`, "image: ghcr.io/serviceware/cloud-connector:0.9.0\n");

    expect(await syncReleaseArtifacts({ root })).toStrictEqual([
      "README.md",
      "docs/nested/guide.md",
      "templates/compose.yaml",
    ]);
    expect(await readFile(`${root}/docs/nested/guide.md`, "utf8")).toStrictEqual(
      "ghcr.io/serviceware/cloud-connector:1.2.3\n",
    );
    expect(await readFile(`${root}/docs/notes.txt`, "utf8")).toStrictEqual(
      "ghcr.io/serviceware/cloud-connector:0.9.0\n",
    );
    expect(await readFile(`${root}/examples/compose.yml`, "utf8")).toStrictEqual(
      "image: ghcr.io/serviceware/cloud-connector:0.9.0\n",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("syncReleaseArtifacts treats missing docs and templates directories as empty", async () => {
  const root = await createFixture();
  try {
    await rm(`${root}/docs`, { recursive: true });
    await rm(`${root}/templates`, { recursive: true });

    expect(await syncReleaseArtifacts({ root, checkOnly: true })).toStrictEqual([]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("syncReleaseArtifacts propagates filesystem errors other than missing files", async () => {
  const root = await createFixture();
  try {
    await rm(`${root}/docs`, { recursive: true });
    await writeFile(`${root}/docs`, "not a directory\n");

    await expect(syncReleaseArtifacts({ root, checkOnly: true })).rejects.toThrow("ENOTDIR");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("syncReleaseArtifacts propagates read errors for maintained files other than missing files", async () => {
  const root = await createFixture();
  try {
    await rm(`${root}/README.md`);
    await mkdir(`${root}/README.md`);

    await expect(syncReleaseArtifacts({ root, checkOnly: true })).rejects.toThrow("EISDIR");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("sync-release-artifacts --check exits non-zero for stale references", async () => {
  const root = await createFixture();
  try {
    await writeFile(`${root}/templates/starter.yml`, "image: ghcr.io/serviceware/cloud-connector:0.9.0\n");

    const result = await runSyncScript(root, ["--check"]);

    expect(result.code).toStrictEqual(1);
    expect(result.stderr).toContain("templates/starter.yml must reference ghcr.io/serviceware/cloud-connector:1.2.3");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("sync-release-artifacts reports the updated files", async () => {
  const root = await createFixture();
  try {
    await writeFile(`${root}/templates/starter.yml`, "image: ghcr.io/serviceware/cloud-connector:0.9.0\n");

    const result = await runSyncScript(root, []);

    expect(result.code).toStrictEqual(0);
    expect(result.stdout).toStrictEqual("Updated release artifacts for 1.2.3: templates/starter.yml\n");
  } finally {
    await rm(root, { recursive: true });
  }
});

async function runSyncScript(
  cwd: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [syncScript, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cloud-connector-release-"));
  await mkdir(`${root}/docs`, { recursive: true });
  await mkdir(`${root}/templates`, { recursive: true });
  await writeFile(`${root}/package.json`, '{"version":"1.2.3"}\n');
  await writeFile(`${root}/CHANGELOG.md`, "# Changelog\n\n## 1.2.3 - 2026-09-14\n");
  await writeFile(`${root}/README.md`, "Use ghcr.io/serviceware/cloud-connector:1.2.3.\n");
  return root;
}
