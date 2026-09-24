import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/hybrid/*.test.js"],
    globals: true,
    environment: "node",
    // Hybrid tests make real AI Core calls — allow up to 15 minutes per file
    testTimeout: 900_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      enabled: true,
      reporters: [["default", { summary: false }], ...configDefaults.reporters],
      reportsDirectory: "coverage/hybrid",
      exclude: ["tests/**", ".scripts/*"],
    },
    silent: true,
  },
})
