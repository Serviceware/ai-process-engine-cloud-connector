import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { syncNodeVersion } from "./sync-node-version.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cloud-connector-node-version-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const digestPinnedImage =
  "FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9\n";

test("syncNodeVersion accepts a matching .node-version", async () => {
  await writeFile(join(root, "Dockerfile"), digestPinnedImage);
  await writeFile(join(root, ".node-version"), "24.22.2\n");

  expect(await syncNodeVersion({ root, checkOnly: true })).toBe(false);
  expect(await syncNodeVersion({ root })).toBe(false);
});

test("syncNodeVersion rejects a stale .node-version in check mode", async () => {
  await writeFile(join(root, "Dockerfile"), digestPinnedImage);
  await writeFile(join(root, ".node-version"), "24.22.1\n");

  await expect(syncNodeVersion({ root, checkOnly: true })).rejects.toThrow(
    ".node-version is '24.22.1' but the Dockerfile uses node:24.22.2",
  );
  expect(await readFile(join(root, ".node-version"), "utf8")).toBe("24.22.1\n");
});

test("syncNodeVersion writes the Dockerfile Node.js version", async () => {
  await writeFile(join(root, "Dockerfile"), digestPinnedImage);
  await writeFile(join(root, ".node-version"), "24.22.1\n");

  expect(await syncNodeVersion({ root })).toBe(true);
  expect(await readFile(join(root, ".node-version"), "utf8")).toBe("24.22.2\n");
});

test("syncNodeVersion rejects a Dockerfile without a versioned Node.js base image", async () => {
  await writeFile(join(root, "Dockerfile"), "FROM node:lts-bookworm-slim\n");
  await writeFile(join(root, ".node-version"), "24.22.2\n");

  await expect(syncNodeVersion({ root, checkOnly: true })).rejects.toThrow(
    "Dockerfile must start from node:MAJOR.MINOR.PATCH-<variant>",
  );
});
