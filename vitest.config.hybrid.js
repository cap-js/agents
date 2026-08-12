export default {
  test: {
    include: ["tests/hybrid/*.test.js"],
    globals: true,
    environment: "node",
    // Hybrid tests make real AI Core calls — allow up to 15 minutes per file
    testTimeout: 900_000,
    hookTimeout: 30_000,
    reporters: ["verbose"],
    silent: true,
  },
}
