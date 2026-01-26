import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    alias: {
      // Alias external packages to allow mocking
      "@chrismlittle123/infra": new URL(
        "./tests/__mocks__/@chrismlittle123/infra.ts",
        import.meta.url
      ).pathname,
      "@pulumi/pulumi": new URL(
        "./tests/__mocks__/@pulumi/pulumi.ts",
        import.meta.url
      ).pathname,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
