const cds = require("@sap/cds")

const TARGETS = ["a2a"]

function _lazyRegisterCompileTargets() {
  const value = require("./compile.js").default
  TARGETS.forEach((target) => Object.defineProperty(this, target, { value }))
  return value
}

// Register a2a as cds.compile.to target
const registerCompileTargets = () => {
  TARGETS.forEach((target) =>
    Object.defineProperty(cds.compile.to, target, {
      get: _lazyRegisterCompileTargets,
      configurable: true,
    }),
  )
}

module.exports = { registerCompileTargets }
