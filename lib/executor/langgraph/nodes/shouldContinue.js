const quotaEnforcerAtNode = require("./quotaEnforcerAtNode")

module.exports = async function shouldContinue(state, config) {
  const res = await quotaEnforcerAtNode(state, config)
  if (res === "end") {
    const err = new Error("Task quota exceeded — execution stopped.")
    err.code = "QUOTA_EXCEEDED_AT_NODE"
    throw err
  }
  return state.toolCalls?.length > 0 ? "tools" : "end"
}
