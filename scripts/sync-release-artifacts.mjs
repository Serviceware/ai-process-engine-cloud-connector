import { readFile, writeFile } from "node:fs/promises";

const checkOnly = process.argv.includes("--check");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const version = packageJson.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(
    `package.json version must use MAJOR.MINOR.PATCH, got ${version}`,
  );
}

const composeFiles = [
  "templates/starter/docker-compose.yml",
  "templates/examples/ticketing-yaml/docker-compose.yml",
];
const imagePattern = /(ghcr\.io\/serviceware\/cloud-connector:)([^\s"']+)/g;
const expectedImage = `ghcr.io/serviceware/cloud-connector:${version}`;
const changedFiles = [];

const lockfilePath = "package-lock.json";
const lockfileText = await readFile(lockfilePath, "utf8");
const lockfile = JSON.parse(lockfileText);
if (
  lockfile.name !== packageJson.name ||
  lockfile.packages?.[""]?.name !== packageJson.name
) {
  throw new Error(`${lockfilePath} package name does not match package.json`);
}
if (lockfile.version !== version || lockfile.packages[""].version !== version) {
  if (checkOnly) {
    throw new Error(`${lockfilePath} must use version ${version}`);
  }
  lockfile.version = version;
  lockfile.packages[""].version = version;
  await writeFile(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);
  changedFiles.push(lockfilePath);
}

for (const path of composeFiles) {
  const original = await readFile(path, "utf8");
  const matches = [...original.matchAll(imagePattern)];
  if (matches.length !== 1) {
    throw new Error(`${path} must contain exactly one Cloud Connector image`);
  }

  const updated = original.replace(imagePattern, `$1${version}`);
  if (updated !== original) {
    if (checkOnly) {
      throw new Error(`${path} must reference ${expectedImage}`);
    }
    await writeFile(path, updated);
    changedFiles.push(path);
  }
}

const changelogPath = "CHANGELOG.md";
const changelog = await readFile(changelogPath, "utf8");
const datedHeading = new RegExp(`^## ${version} - \\d{4}-\\d{2}-\\d{2}$`, "m");

if (!datedHeading.test(changelog)) {
  if (checkOnly) {
    throw new Error(`${changelogPath} has no dated ${version} release heading`);
  }

  const undatedHeading = new RegExp(`^## ${version}$`, "m");
  if (!undatedHeading.test(changelog)) {
    throw new Error(`${changelogPath} has no ${version} release heading`);
  }

  const releaseDate = new Date().toISOString().slice(0, 10);
  const updated = changelog.replace(
    undatedHeading,
    `## ${version} - ${releaseDate}`,
  );
  await writeFile(changelogPath, updated);
  changedFiles.push(changelogPath);
}

if (changedFiles.length > 0) {
  console.log(
    `Updated release artifacts for ${version}: ${changedFiles.join(", ")}`,
  );
} else {
  console.log(`Release artifacts already match ${version}`);
}
