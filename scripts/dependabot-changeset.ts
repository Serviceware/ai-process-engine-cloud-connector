import { readFile, writeFile } from "node:fs/promises";
import { parseChangeset, renderChangeset, runGit } from "./changeset.ts";
import { readNodeBaseImage } from "./sync-node-version.ts";

export type ImageInputs = {
  packageJson: string;
  dockerfile: string;
};

type ImageChange =
  | { kind: "node"; from: string; to: string }
  | { kind: "base-image"; tag: string }
  | { kind: "dependency"; name: string; from: string; to: string };

const nodeSummary = /^Run on Node\.js (\S+) instead of (\S+)\.$/;
const baseImageSummary = /^Rebuild on the updated `[^`]+` base image\.$/;
const dependencySummary = /^Update (\S+) from (\S+) to (\S+)\.$/;

/**
 * Plans one pending Changeset per updated component, so each component appears once in the changelog.
 * `existing` maps Changeset paths to their current content; the result holds only files to write.
 */
export function planDependabotChangesets(
  base: ImageInputs,
  head: ImageInputs,
  existing: Record<string, string>,
): Record<string, string> {
  const planned: Record<string, string> = {};
  for (const change of findImageChanges(base, head)) {
    const path = changesetPath(change);
    const current = existing[path];
    const summary = mergeSummary(
      change,
      current === undefined ? undefined : parseChangeset(current, path).summary,
      path,
    );
    if (summary === undefined) continue;
    const content = renderChangeset("patch", summary);
    if (content !== current) planned[path] = content;
  }
  return planned;
}

function changesetPath(change: ImageChange): string {
  if (change.kind === "dependency") {
    return `.changeset/dependabot-${change.name.replace(/^@/, "").replaceAll("/", "-")}.md`;
  }
  return ".changeset/dependabot-node.md";
}

function findImageChanges(base: ImageInputs, head: ImageInputs): ImageChange[] {
  const changes: ImageChange[] = [];

  const baseImage = readNodeBaseImage(base.dockerfile);
  const headImage = readNodeBaseImage(head.dockerfile);
  if (baseImage.version !== headImage.version) {
    changes.push({ kind: "node", from: baseImage.version, to: headImage.version });
  } else if (baseImage.reference !== headImage.reference) {
    changes.push({ kind: "base-image", tag: headImage.reference.split("@")[0] });
  }

  const baseDependencies = readDependencies(base.packageJson);
  const headDependencies = readDependencies(head.packageJson);
  const names = [...new Set([...Object.keys(baseDependencies), ...Object.keys(headDependencies)])].sort();
  for (const name of names) {
    const from = baseDependencies[name];
    const to = headDependencies[name];
    if (from === to) continue;
    if (from === undefined || to === undefined) {
      throw new Error(`Dependabot ${from === undefined ? "added" : "removed"} ${name}; write its Changeset by hand`);
    }
    changes.push({ kind: "dependency", name, from, to });
  }

  return changes;
}

/** Keeps the first version of a pending update and any text a maintainer added after the generated sentence. */
function mergeSummary(change: ImageChange, current: string | undefined, path: string): string | undefined {
  const [generated, ...added] = (current ?? "").split(/\r?\n/);
  const rest = added.length > 0 ? `\n${added.join("\n")}` : "";

  if (change.kind === "base-image") {
    if (current !== undefined) return undefined;
    return `Rebuild on the updated \`${change.tag}\` base image.`;
  }

  if (change.kind === "node") {
    let from = change.from;
    if (current !== undefined) {
      const match = generated.match(nodeSummary);
      if (match) from = match[2];
      else if (!baseImageSummary.test(generated)) throw unexpectedSummary(path);
    }
    return `Run on Node.js ${change.to} instead of ${from}.${rest}`;
  }

  let from = change.from;
  if (current !== undefined) {
    const match = generated.match(dependencySummary);
    if (!match || match[1] !== change.name) throw unexpectedSummary(path);
    from = match[2];
  }
  return `Update ${change.name} from ${from} to ${change.to}.${rest}`;
}

function unexpectedSummary(path: string): Error {
  return new Error(`${path} does not start with the generated summary sentence; update it by hand`);
}

function readDependencies(packageJson: string): Record<string, string> {
  const dependencies = (JSON.parse(packageJson) as { dependencies?: unknown }).dependencies ?? {};
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    throw new Error("package.json dependencies must be an object");
  }
  return dependencies as Record<string, string>;
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeDependabotChangesets(args: string[]): Promise<void> {
  const baseRef = args.find((argument) => argument.startsWith("--base="))?.slice("--base=".length);
  if (!baseRef) {
    throw new Error("Usage: dependabot-changeset.ts --base=REF");
  }

  const mergeBase = await runGit(["merge-base", baseRef, "HEAD"]);
  const base = {
    packageJson: await runGit(["show", `${mergeBase}:package.json`]),
    dockerfile: await runGit(["show", `${mergeBase}:Dockerfile`]),
  };
  const head = {
    packageJson: await readFile("package.json", "utf8"),
    dockerfile: await readFile("Dockerfile", "utf8"),
  };

  const existing: Record<string, string> = {};
  for (const change of findImageChanges(base, head)) {
    const path = changesetPath(change);
    const content = await readExisting(path);
    if (content !== undefined) existing[path] = content;
  }

  const planned = planDependabotChangesets(base, head, existing);
  for (const [path, content] of Object.entries(planned)) {
    await writeFile(path, content);
    console.log(`Wrote ${path}`);
  }
  if (Object.keys(planned).length === 0) {
    console.log("Pending Changesets already describe this update");
  }
}

if (import.meta.main) await writeDependabotChangesets(process.argv.slice(2));
