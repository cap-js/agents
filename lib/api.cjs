const cds = require("@sap/cds")

const TARGETS = ["a2a"]

// Register a2a as cds.compile.to target
const registerCompileTargets = async () => {
  const { default: compile } = await import("./compile.js")
  TARGETS.forEach((target) =>
    Object.defineProperty(cds.compile.to, target, {
      value: compile,
      configurable: true,
    }),
  )
}

module.exports = { registerCompileTargets }
