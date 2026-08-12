export default {
  test: {
    include: ["tests/integration/*.test.js"],
    setupFiles: ["tests/utils/setup.js"],
    globals: true,
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ["verbose"],
    silent: true,
  },
}
