const cds = require("@sap/cds")

const TARGETS = ["a2a"]

function _lazyRegisterCompileTargets() {
  const { default: compile } = require("./compile.js")
  TARGETS.forEach((target) =>
    Object.defineProperty(this, target, {
      value: compile,
      configurable: true,
    }),
  )
  return compile
}

const registerCompileTargets = () => {
  TARGETS.forEach((target) =>
    Object.defineProperty(cds.compile.to, target, {
      get: _lazyRegisterCompileTargets,
      configurable: true,
    }),
  )
}

module.exports = { registerCompileTargets }
