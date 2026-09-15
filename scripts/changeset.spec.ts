import { assertEquals, assertThrows } from "@std/assert";
import { bumpVersion, parseChangeset } from "./changeset.ts";

Deno.test("parses release and empty changesets", () => {
  assertEquals(
    parseChangeset(
      '---\n"@serviceware/cloud-connector": minor\n---\n\nAdd a feature.\n',
    ),
    { bump: "minor", summary: "Add a feature." },
  );
  assertEquals(parseChangeset("---\n---\n"), { summary: "" });
});

Deno.test("rejects malformed changesets", () => {
  assertThrows(() => parseChangeset("No front matter"));
  assertThrows(() =>
    parseChangeset('---\n"@serviceware/cloud-connector": major\n---\n')
  );
});

Deno.test("bumps semantic versions", () => {
  assertEquals(bumpVersion("1.0.0", "patch"), "1.0.1");
  assertEquals(bumpVersion("1.2.3", "minor"), "1.3.0");
  assertEquals(bumpVersion("0.8.7", "major"), "1.0.0");
  assertThrows(() => bumpVersion("v1.0.0", "patch"));
});
