const cds = require("@sap/cds")

const LOG = cds.log("a2a")

/**
 * Initialize the LLM
 *
 * Resolution order for the model:
 *   1. srv.a2a.model as factory function (tools) => model
 *   2. srv.a2a.model as a LangChain BaseChatModel instance (plugin calls .bindTools)
 *   3. Default: OrchestrationClient from @sap-ai-sdk/langchain
 */
async function createModel(srv, tools) {
  const override = srv?.a2a?.model

  if (typeof override === "function") {
    LOG.info("Using custom model factory", { service: srv.name })
    return await override(tools)
  }

  if (override && typeof override.bindTools === "function") {
    LOG.info("Using custom model instance", { service: srv.name })
    return override.bindTools(tools)
  }

  const { OrchestrationClient } = await import("@sap-ai-sdk/langchain")

  const modelName = cds.env.a2a?.llm || process.env.AICORE_MODEL
  if (!modelName) {
    throw new Error("No LLM model configured. Set cds.env.a2a.llm or AICORE_MODEL.")
  }
  const params = cds.env.a2a?.params
  const source = cds.env.a2a?.llm ? "cds.env" : "env"

  LOG.info("Initializing LLM", { model: modelName, source })

  const rawModel = new OrchestrationClient({
    promptTemplating: {
      model: {
        name: modelName,
        params,
      },
    },
  })

  const model = rawModel.bindTools(tools)
  return model
}

module.exports = { createModel }
