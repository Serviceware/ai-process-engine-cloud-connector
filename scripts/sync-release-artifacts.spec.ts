import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { syncReleaseArtifacts } from "./sync-release-artifacts.ts";

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

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cloud-connector-release-"));
  await mkdir(`${root}/docs`, { recursive: true });
  await mkdir(`${root}/templates`, { recursive: true });
  await writeFile(`${root}/package.json`, '{"version":"1.2.3"}\n');
  await writeFile(`${root}/CHANGELOG.md`, "# Changelog\n\n## 1.2.3 - 2026-09-14\n");
  await writeFile(`${root}/README.md`, "Use ghcr.io/serviceware/cloud-connector:1.2.3.\n");
  return root;
}
