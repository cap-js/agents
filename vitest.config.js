import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/integration/*.test.js"],
    globals: true,
    environment: "node",
    testTimeout: 30_000,
    reporters: ["verbose"],
  },
})
