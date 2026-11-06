export { tool } from "@langchain/core/tools"

export async function createAgent({ recursionLimit = 100, ...options }) {
  const { createAgent } = await import("langchain")
  return createAgent(options).withConfig({ recursionLimit })
}
