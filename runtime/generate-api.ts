import { OpenApiGenerator } from "@goast/core";
import { TypeScriptModelsGenerator } from "@goast/typescript";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const sourceDir = resolve(import.meta.dirname, "../openapi");
const outputDir = resolve(import.meta.dirname, "generated");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

await new OpenApiGenerator({ outputDir })
  .useType(TypeScriptModelsGenerator, {
    importModuleTransformer: "with-extension",
  })
  .parseAndGenerateFromDir(sourceDir);
