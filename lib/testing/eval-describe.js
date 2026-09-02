import { evalRun } from "./eval-run.js"

const PATCHED = Symbol.for("@cap-js/agents:eval-describe-patched")

export function installEvalDescribe({
  target = globalThis,
  evalRun: registerEvalRun = evalRun,
} = {}) {
  const original = target.describe
  if (typeof original !== "function") return false
  if (original[PATCHED]) return false

  let depth = 0

  const wrapSuite = (suite) => {
    if (typeof suite !== "function") return suite

    const wrapped = function evalDescribe(name, factory, ...args) {
      if (typeof factory !== "function") return suite.call(this, name, factory, ...args)

      return suite.call(
        this,
        name,
        function evalSuite(...suiteArgs) {
          depth += 1
          const topLevel = depth === 1
          try {
            if (topLevel && typeof name === "string") registerEvalRun({ name })
            return factory.apply(this, suiteArgs)
          } finally {
            depth -= 1
          }
        },
        ...args,
      )
    }

    copySuiteProperties(suite, wrapped, wrapSuite)
    return wrapped
  }

  target.describe = wrapSuite(original)
  target.describe[PATCHED] = true
  target.describe._original = original
  return true
}

function copySuiteProperties(source, target, wrapSuite) {
  for (const key of Reflect.ownKeys(source)) {
    if (["length", "name", "prototype"].includes(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (!descriptor) continue
    if (typeof descriptor.value === "function") {
      if (["each", "skipIf", "runIf"].includes(key)) {
        descriptor.value = function describeFactory(...args) {
          return wrapSuite(source[key].apply(this, args))
        }
      } else {
        descriptor.value = wrapSuite(descriptor.value)
      }
    }
    try {
      Object.defineProperty(target, key, descriptor)
    } catch {
      // Vitest may expose non-configurable helper properties. The base describe
      // still works, so ignore properties that cannot be mirrored.
    }
  }
}
