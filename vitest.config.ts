import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["runtime/**/*.ts", "scripts/**/*.ts"],
      exclude: ["**/*.spec.ts", "runtime/generated/**", "runtime/generate-api.ts"],
      reporter: ["text", "lcov"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["runtime/**/*.spec.ts", "scripts/**/*.spec.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["integration/**/*.spec.ts"],
          // The connector binds its fixed probe port 8080.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
