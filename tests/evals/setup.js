/**
 * Vitest setup file: patches cds.test.Test.prototype with the .agents getter
 * so test files can call cds.test(dir).agents.evalRun() at top level.
 *
 * Runs in the same worker context as the test files, before any test module
 * code executes — which is the only way to guarantee the prototype is patched
 * before top-level destructuring like:
 *
 *   const { runAgent } = cds.test(dir).agents.evalRun()
 */
import cds from "@sap/cds"
import { buildAgentsHelpers } from "../../lib/testing/index.js"

const CDS_TEST_AGENTS_PATCHED = Symbol.for("@cap-js/agents:cds-test-agents-patched")
const CDS_TEST_AGENTS_SLOT = Symbol.for("@cap-js/agents:cds-test-agents-slot")

const Test = cds.test?.Test
const proto = Test?.prototype
if (proto && !proto[CDS_TEST_AGENTS_PATCHED]) {
  Object.defineProperty(proto, "agents", {
    configurable: true,
    get() {
      if (this[CDS_TEST_AGENTS_SLOT]) return this[CDS_TEST_AGENTS_SLOT]
      const helpers = buildAgentsHelpers(this)
      Object.defineProperty(this, CDS_TEST_AGENTS_SLOT, {
        value: helpers,
        enumerable: false,
        writable: false,
        configurable: false,
      })
      return helpers
    },
  })
  Object.defineProperty(proto, CDS_TEST_AGENTS_PATCHED, { value: true, enumerable: false })
}
