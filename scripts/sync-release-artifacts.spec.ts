import { assertEquals, assertRejects } from "@std/assert";
import { syncReleaseArtifacts } from "./sync-release-artifacts.ts";

Deno.test("syncReleaseArtifacts checks and updates discovered release references", async () => {
  const root = await createFixture();
  try {
    assertEquals(await syncReleaseArtifacts({ root, checkOnly: true }), []);

    await Deno.writeTextFile(
      `${root}/templates/starter.yml`,
      "image: ghcr.io/serviceware/cloud-connector:0.9.0\n",
    );
    await assertRejects(
      () => syncReleaseArtifacts({ root, checkOnly: true }),
      Error,
      "must reference ghcr.io/serviceware/cloud-connector:1.2.3",
    );

    await Deno.writeTextFile(
      `${root}/CHANGELOG.md`,
      "# Changelog\n\n## 1.2.3\n",
    );
    assertEquals(
      await syncReleaseArtifacts({ root, releaseDate: "2026-09-15" }),
      ["templates/starter.yml", "CHANGELOG.md"],
    );
    assertEquals(
      await Deno.readTextFile(`${root}/templates/starter.yml`),
      "image: ghcr.io/serviceware/cloud-connector:1.2.3\n",
    );
    assertEquals(
      await Deno.readTextFile(`${root}/CHANGELOG.md`),
      "# Changelog\n\n## 1.2.3 - 2026-09-15\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("syncReleaseArtifacts enforces one image reference per maintained file", async () => {
  const root = await createFixture();
  try {
    await Deno.writeTextFile(
      `${root}/docs/images.md`,
      "ghcr.io/serviceware/cloud-connector:1.2.3\n" +
        "ghcr.io/serviceware/cloud-connector:0.9.0\n",
    );
    await assertRejects(
      () => syncReleaseArtifacts({ root, checkOnly: true }),
      Error,
      "must contain exactly one Cloud Connector image",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function createFixture(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs`, { recursive: true });
  await Deno.mkdir(`${root}/templates`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/deno.json`,
    '{"version":"1.2.3"}\n',
  );
  await Deno.writeTextFile(
    `${root}/CHANGELOG.md`,
    "# Changelog\n\n## 1.2.3 - 2026-09-14\n",
  );
  await Deno.writeTextFile(
    `${root}/README.md`,
    "Use ghcr.io/serviceware/cloud-connector:1.2.3.\n",
  );
  return root;
}
