import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/hybrid/*.eval.test.js"],
    globals: true,
    environment: "node",
    restoreMocks: true,
    testTimeout: 900_000,
    hookTimeout: 30_000,
    reporters: ["verbose"],
  },
})
