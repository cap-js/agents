export default {
  test: {
    include: ["tests/integration/*.test.js"],
    globals: true,
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ["verbose"],
  },
}
