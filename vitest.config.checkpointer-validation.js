import config from "./vitest.config.js"

export default {
  ...config,
  test: {
    ...config.test,
    include: ["tests/checkpointer-validation/*.test.js"],
  },
}
