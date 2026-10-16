import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  const root = options.root ?? process.cwd();
  const checkOnly = options.checkOnly ?? false;
  const version = await readVersion(root);

  const expectedImage = `ghcr.io/serviceware/cloud-connector:${version}`;
  const changedFiles: string[] = [];
  const imageReferenceFiles = await discoverImageReferenceFiles(root);

  for (const relativePath of imageReferenceFiles) {
    const path = join(root, relativePath);
    const original = await readFile(path, "utf8");
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
      await writeFile(path, updated);
      changedFiles.push(relativePath);
    }
  }

  const changelogPath = "CHANGELOG.md";
  const changelog = await readFile(join(root, changelogPath), "utf8");
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

    const releaseDate =
      options.releaseDate ?? new Date().toISOString().slice(0, 10);
    const updated = changelog.replace(
      undatedHeading,
      `## ${version} - ${releaseDate}`,
    );
    await writeFile(join(root, changelogPath), updated);
    changedFiles.push(changelogPath);
  }

  return changedFiles;
}

async function readVersion(root: string): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const version = packageJson.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `package.json version must use MAJOR.MINOR.PATCH, got ${version}`,
    );
  }
  return version;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function discoverImageReferenceFiles(root: string): Promise<string[]> {
  const candidates = ["README.md"];
  for (const directory of ["docs", "templates"]) {
    candidates.push(...(await listTextFiles(root, directory)));
  }

  const references: string[] = [];
  for (const relativePath of candidates) {
    try {
      const content = await readFile(join(root, relativePath), "utf8");
      if ([...content.matchAll(imagePattern)].length > 0) {
        references.push(relativePath);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
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
    const entries = await readdir(join(root, relativeDirectory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        result.push(...(await listTextFiles(root, relativePath)));
      } else if (
        entry.isFile() &&
        textExtensions.some((extension) => entry.name.endsWith(extension))
      ) {
        result.push(relativePath);
      }
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (import.meta.main) {
  const checkOnly = process.argv.includes("--check");
  const changedFiles = await syncReleaseArtifacts({ checkOnly });
  const version = await readVersion(process.cwd());
  if (changedFiles.length > 0) {
    console.log(
      `Updated release artifacts for ${version}: ${changedFiles.join(", ")}`,
    );
  } else {
    console.log(`Release artifacts already match ${version}`);
  }
}
