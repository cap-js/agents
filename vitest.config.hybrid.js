import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/hybrid/*.test.js"],
    globals: true,
    environment: "node",
    // Hybrid tests make real AI Core calls — allow up to 15 minutes per file
    testTimeout: 900_000,
    reporters: ["verbose"],
  },
})
