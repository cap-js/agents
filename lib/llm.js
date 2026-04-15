const cds = require("@sap/cds")

const LOG = cds.log("a2a")

/**
 * Initialize the LLM
 *
 */
async function createModel(tools) {
  const { OrchestrationClient } = await import("@sap-ai-sdk/langchain")

  const modelName = cds.env.a2a?.llm || process.env.AICORE_MODEL || "anthropic--claude-4.5-sonnet"

  LOG.info("Initializing LLM", { model: modelName })

  const rawModel = new OrchestrationClient({
    promptTemplating: {
      model: {
        name: modelName,
        params: {
          max_tokens: 4096,
          temperature: 0,
        },
      },
    },
  })

  const model = rawModel.bindTools(tools)
  return { model, rawModel }
}

module.exports = { createModel }
