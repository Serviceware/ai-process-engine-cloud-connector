import { join } from "@std/path";

export type SyncReleaseArtifactsOptions = {
  root?: string;
  checkOnly?: boolean;
  releaseDate?: string;
};

const imagePattern =
  /(ghcr\.io\/serviceware\/cloud-connector:)(\d+\.\d+\.\d+)/g;
const textExtensions = [".md", ".yml", ".yaml"];

export async function syncReleaseArtifacts(
  options: SyncReleaseArtifactsOptions = {},
): Promise<string[]> {
  const root = options.root ?? Deno.cwd();
  const checkOnly = options.checkOnly ?? false;
  const denoJson = JSON.parse(await Deno.readTextFile(join(root, "deno.json")));
  const version = denoJson.version;

  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `deno.json version must use MAJOR.MINOR.PATCH, got ${version}`,
    );
  }

  const expectedImage = `ghcr.io/serviceware/cloud-connector:${version}`;
  const changedFiles: string[] = [];
  const imageReferenceFiles = await discoverImageReferenceFiles(root);

  for (const relativePath of imageReferenceFiles) {
    const path = join(root, relativePath);
    const original = await Deno.readTextFile(path);
    const matches = [...original.matchAll(imagePattern)];
    if (matches.length !== 1) {
      throw new Error(
        `${relativePath} must contain exactly one Cloud Connector image`,
      );
    }

    const updated = original.replace(imagePattern, `$1${version}`);
    if (updated !== original) {
      if (checkOnly) {
        throw new Error(`${relativePath} must reference ${expectedImage}`);
      }
      await Deno.writeTextFile(path, updated);
      changedFiles.push(relativePath);
    }
  }

  const changelogPath = "CHANGELOG.md";
  const changelog = await Deno.readTextFile(join(root, changelogPath));
  const escapedVersion = escapeRegExp(version);
  const datedHeading = new RegExp(
    `^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`,
    "m",
  );

  if (!datedHeading.test(changelog)) {
    if (checkOnly) {
      throw new Error(
        `${changelogPath} has no dated ${version} release heading`,
      );
    }

    const undatedHeading = new RegExp(`^## ${escapedVersion}$`, "m");
    if (!undatedHeading.test(changelog)) {
      throw new Error(`${changelogPath} has no ${version} release heading`);
    }

    const releaseDate = options.releaseDate ??
      new Date().toISOString().slice(0, 10);
    const updated = changelog.replace(
      undatedHeading,
      `## ${version} - ${releaseDate}`,
    );
    await Deno.writeTextFile(join(root, changelogPath), updated);
    changedFiles.push(changelogPath);
  }

  return changedFiles;
}

async function discoverImageReferenceFiles(root: string): Promise<string[]> {
  const candidates = ["README.md"];
  for (const directory of ["docs", "templates"]) {
    candidates.push(...await listTextFiles(root, directory));
  }

  const references: string[] = [];
  for (const relativePath of candidates) {
    try {
      const content = await Deno.readTextFile(join(root, relativePath));
      if ([...content.matchAll(imagePattern)].length > 0) {
        references.push(relativePath);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return references.sort();
}

async function listTextFiles(
  root: string,
  relativeDirectory: string,
): Promise<string[]> {
  const result: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(root, relativeDirectory))) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory) {
        result.push(...await listTextFiles(root, relativePath));
      } else if (
        entry.isFile &&
        textExtensions.some((extension) => entry.name.endsWith(extension))
      ) {
        result.push(relativePath);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (import.meta.main) {
  const checkOnly = Deno.args.includes("--check");
  const changedFiles = await syncReleaseArtifacts({ checkOnly });
  const version = JSON.parse(await Deno.readTextFile("deno.json")).version;
  if (changedFiles.length > 0) {
    console.log(
      `Updated release artifacts for ${version}: ${changedFiles.join(", ")}`,
    );
  } else {
    console.log(`Release artifacts already match ${version}`);
  }
}
