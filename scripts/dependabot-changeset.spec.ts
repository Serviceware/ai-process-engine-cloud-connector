import { expect, test } from "vitest";
import { renderChangeset } from "./changeset.ts";
import { type ImageInputs, planDependabotChangesets } from "./dependabot-changeset.ts";

const digestA = "sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9";
const digestB = "sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c";

function inputs(
  nodeImage: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string> = {},
): ImageInputs {
  return {
    dockerfile: `FROM node:${nodeImage}\n\nWORKDIR /app\n`,
    packageJson: JSON.stringify({ name: "@serviceware/cloud-connector", dependencies, devDependencies }),
  };
}

const node22 = `24.22.2-bookworm-slim@${digestA}`;

test("ignores dev dependency updates", () => {
  const base = inputs(node22, { undici: "7.30.1" }, { vitest: "5.0.4" });
  const head = inputs(node22, { undici: "7.30.1" }, { vitest: "5.1.0" });

  expect(planDependabotChangesets(base, head, {})).toStrictEqual({});
});

test("writes one Changeset per updated runtime dependency", () => {
  const base = inputs(node22, { "@scope/pkg": "1.0.0", undici: "7.30.1", yaml: "2.9.1" });
  const head = inputs(node22, { "@scope/pkg": "1.1.0", undici: "7.30.2", yaml: "2.9.1" });

  expect(planDependabotChangesets(base, head, {})).toStrictEqual({
    ".changeset/dependabot-scope-pkg.md": renderChangeset("patch", "Update @scope/pkg from 1.0.0 to 1.1.0."),
    ".changeset/dependabot-undici.md": renderChangeset("patch", "Update undici from 7.30.1 to 7.30.2."),
  });
});

test("extends a pending dependency Changeset and keeps its first version and added text", () => {
  const base = inputs(node22, { undici: "7.30.1" });
  const head = inputs(node22, { undici: "7.30.2" });
  const existing = {
    ".changeset/dependabot-undici.md": renderChangeset(
      "patch",
      "Update undici from 7.30.0 to 7.30.1.\nFixes a TLS validation bypass.",
    ),
  };

  expect(planDependabotChangesets(base, head, existing)).toStrictEqual({
    ".changeset/dependabot-undici.md": renderChangeset(
      "patch",
      "Update undici from 7.30.0 to 7.30.2.\nFixes a TLS validation bypass.",
    ),
  });
});

test("leaves an up-to-date Changeset unchanged", () => {
  const base = inputs(node22, { undici: "7.30.1" });
  const head = inputs(node22, { undici: "7.30.2" });
  const existing = {
    ".changeset/dependabot-undici.md": renderChangeset("patch", "Update undici from 7.30.0 to 7.30.2."),
  };

  expect(planDependabotChangesets(base, head, existing)).toStrictEqual({});
});

test("rejects a pending Changeset without the generated sentence", () => {
  const base = inputs(node22, { undici: "7.30.1" });
  const head = inputs(node22, { undici: "7.30.2" });
  const existing = {
    ".changeset/dependabot-undici.md": renderChangeset("patch", "Fix TLS handling by updating undici."),
  };

  expect(() => planDependabotChangesets(base, head, existing)).toThrow(
    ".changeset/dependabot-undici.md does not start with the generated summary sentence",
  );
});

test("describes a Node.js update and extends a pending one", () => {
  const base = inputs(`24.22.2-bookworm-slim@${digestB}`, {});
  const head = inputs(`24.22.3-bookworm-slim@${digestA}`, {});

  expect(planDependabotChangesets(base, head, {})).toStrictEqual({
    ".changeset/dependabot-node.md": renderChangeset("patch", "Run on Node.js 24.22.3 instead of 24.22.2."),
  });
  expect(
    planDependabotChangesets(base, head, {
      ".changeset/dependabot-node.md": renderChangeset("patch", "Run on Node.js 24.22.2 instead of 24.22.1."),
    }),
  ).toStrictEqual({
    ".changeset/dependabot-node.md": renderChangeset("patch", "Run on Node.js 24.22.3 instead of 24.22.1."),
  });
});

test("describes a rebuilt base image only when no Node.js Changeset is pending", () => {
  const base = inputs(`24.22.2-bookworm-slim@${digestB}`, {});
  const head = inputs(`24.22.2-bookworm-slim@${digestA}`, {});

  expect(planDependabotChangesets(base, head, {})).toStrictEqual({
    ".changeset/dependabot-node.md": renderChangeset(
      "patch",
      "Rebuild on the updated `node:24.22.2-bookworm-slim` base image.",
    ),
  });
  expect(
    planDependabotChangesets(base, head, {
      ".changeset/dependabot-node.md": renderChangeset("patch", "Run on Node.js 24.22.2 instead of 24.22.1."),
    }),
  ).toStrictEqual({});
});

test("replaces a pending rebuild Changeset with a Node.js update", () => {
  const base = inputs(`24.22.2-bookworm-slim@${digestB}`, {});
  const head = inputs(`24.22.3-bookworm-slim@${digestA}`, {});
  const existing = {
    ".changeset/dependabot-node.md": renderChangeset(
      "patch",
      "Rebuild on the updated `node:24.22.2-bookworm-slim` base image.",
    ),
  };

  expect(planDependabotChangesets(base, head, existing)).toStrictEqual({
    ".changeset/dependabot-node.md": renderChangeset("patch", "Run on Node.js 24.22.3 instead of 24.22.2."),
  });
});

test("rejects dependencies that Dependabot added or removed", () => {
  const base = inputs(node22, { undici: "7.30.1" });
  const head = inputs(node22, { undici: "7.30.1", yaml: "2.9.1" });

  expect(() => planDependabotChangesets(base, head, {})).toThrow("Dependabot added yaml; write its Changeset by hand");
});
