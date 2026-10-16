import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { bumpVersion, parseChangeset } from "./changeset.ts";

test("parses release and empty changesets", () => {
  expect(
    parseChangeset(
      '---\n"@serviceware/cloud-connector": minor\n---\n\nAdd a feature.\n',
    ),
  ).toStrictEqual({ bump: "minor", summary: "Add a feature." });
  expect(parseChangeset("---\n---\n")).toStrictEqual({ summary: "" });
});

test("rejects malformed changesets", () => {
  expect(() => parseChangeset("No front matter")).toThrow(
    "must contain YAML-style front matter",
  );
  expect(() =>
    parseChangeset('---\n"@serviceware/cloud-connector": major\n---\n'),
  ).toThrow("must include a user-facing summary");
});

test("bumps semantic versions", () => {
  expect(bumpVersion("1.0.0", "patch")).toStrictEqual("1.0.1");
  expect(bumpVersion("1.2.3", "minor")).toStrictEqual("1.3.0");
  expect(bumpVersion("0.8.7", "major")).toStrictEqual("1.0.0");
  expect(() => bumpVersion("v1.0.0", "patch")).toThrow(
    "Version must use MAJOR.MINOR.PATCH",
  );
});

test("changeset add fails clearly when standard input is closed", async () => {
  const child = spawn(process.execPath, ["scripts/changeset.ts", "add"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

  const [code] = await once(child, "close");

  expect(code).toStrictEqual(1);
  expect(stderr).toContain("Standard input closed before answering");
});
