import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SyncNodeVersionOptions = {
  root?: string;
  checkOnly?: boolean;
};

export type NodeBaseImage = {
  /** Complete image reference including tag and digest, such as `node:24.22.2-bookworm-slim@sha256:...`. */
  reference: string;
  version: string;
};

const baseImagePattern = /^FROM (node:(\d+\.\d+\.\d+)-\S+)/m;

export function readNodeBaseImage(dockerfile: string): NodeBaseImage {
  const match = dockerfile.match(baseImagePattern);
  if (!match) {
    throw new Error("Dockerfile must start from node:MAJOR.MINOR.PATCH-<variant>");
  }
  return { reference: match[1], version: match[2] };
}

export async function syncNodeVersion(options: SyncNodeVersionOptions = {}): Promise<boolean> {
  const root = options.root ?? process.cwd();
  const image = readNodeBaseImage(await readFile(join(root, "Dockerfile"), "utf8")).version;

  const pinned = (await readFile(join(root, ".node-version"), "utf8")).trim();
  if (pinned === image) return false;
  if (options.checkOnly) {
    throw new Error(
      `.node-version is '${pinned}' but the Dockerfile uses node:${image}; run pnpm run node-version:sync`,
    );
  }

  await writeFile(join(root, ".node-version"), `${image}\n`);
  return true;
}

if (import.meta.main) {
  const changed = await syncNodeVersion({ checkOnly: process.argv.includes("--check") });
  console.log(changed ? "Updated .node-version from the Dockerfile" : ".node-version matches the Dockerfile");
}
