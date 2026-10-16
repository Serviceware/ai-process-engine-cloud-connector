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
