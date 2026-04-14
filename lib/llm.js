const cds = require("@sap/cds")

const LOG = cds.log("a2a")

/**
 * Initialize the LLM model via SAP AI SDK OrchestrationClient.
 *
 * @param {import('@langchain/core/tools').StructuredTool[]} tools - Tools to bind to the model
 * @returns {Promise<{ model: object, rawModel: object }>}
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
