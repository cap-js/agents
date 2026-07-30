import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/evals/*.eval.test.js"],
    globals: true,
    environment: "node",
    // Evals make real AI Core calls for both the agent and the LLM-as-judge —
    // allow long timeouts like the hybrid suite.
    testTimeout: 900_000,
    hookTimeout: 30_000,
    reporters: ["verbose"],
  },
})
