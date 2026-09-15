const checkOnly = Deno.args.includes("--check");
const packageJson = JSON.parse(await Deno.readTextFile("package.json"));
const version = packageJson.version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
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
const changedFiles: string[] = [];

for (const path of composeFiles) {
  const original = await Deno.readTextFile(path);
  const matches = [...original.matchAll(imagePattern)];
  if (matches.length !== 1) {
    throw new Error(`${path} must contain exactly one Cloud Connector image`);
  }

  const updated = original.replace(imagePattern, `$1${version}`);
  if (updated !== original) {
    if (checkOnly) {
      throw new Error(`${path} must reference ${expectedImage}`);
    }
    await Deno.writeTextFile(path, updated);
    changedFiles.push(path);
  }
}

const changelogPath = "CHANGELOG.md";
const changelog = await Deno.readTextFile(changelogPath);
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
  await Deno.writeTextFile(changelogPath, updated);
  changedFiles.push(changelogPath);
}

if (changedFiles.length > 0) {
  console.log(
    `Updated release artifacts for ${version}: ${changedFiles.join(", ")}`,
  );
} else {
  console.log(`Release artifacts already match ${version}`);
}
