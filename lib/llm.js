const cds = require("@sap/cds")
const metrics = require("./telemetry/metrics")
const { INSTRUMENTED } = require("./telemetry/tracing")

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

  LOG.debug("Initializing LLM", { model: modelName, source })

  class InstrumentedOrchestrationClient extends OrchestrationClient {
    async _generate(messages, opts, runManager) {
      const tracer = metrics.getTracer()
      const node = opts?.runName || "agent"
      const mAttrs = {
        "sap.tenantId": cds.context?.tenant || "anonymous",
        "a2a.service": cds.context?.["a2a.service"],
        model: modelName,
        node,
      }

      const invoke = async (span) => {
        if (span) {
          span.setAttribute("gen_ai.operation.name", "chat")
          span.setAttribute("gen_ai.provider.name", "sap-ai-core")
          span.setAttribute("gen_ai.request.model", modelName)
          if (params?.temperature != null)
            span.setAttribute("gen_ai.request.temperature", params.temperature)
          if (params?.max_tokens != null)
            span.setAttribute("gen_ai.request.max_tokens", params.max_tokens)
          if (cds.context?.["a2a.context.id"])
            span.setAttribute("gen_ai.conversation.id", cds.context["a2a.context.id"])
          span.setAttribute("a2a.span.kind", "chat")
          span.setAttribute("a2a.llm.node", node)
          if (LOG._debug) {
            const content = JSON.stringify(messages.map((m) => m.content))
            span.setAttribute("gen_ai.input.messages", content)
            span.setAttribute("a2a.entity.input", content)
          }
        }

        let result
        try {
          result = await super._generate(messages, opts, runManager)
        } catch (err) {
          metrics.llmInvocations.add(1, { ...mAttrs, outcome: "error" })
          if (span) {
            span.setAttribute("error.type", err.constructor?.name || "Error")
            span.setStatus({ code: 2, message: err.message })
          }
          throw err
        }

        metrics.llmInvocations.add(1, { ...mAttrs, outcome: "success" })
        const usage = result.generations?.[0]?.message?.usage_metadata
        if (usage?.input_tokens) {
          metrics.llmInputTokens.add(usage.input_tokens, mAttrs)
          if (span) span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens)
        }
        if (usage?.output_tokens) {
          metrics.llmOutputTokens.add(usage.output_tokens, mAttrs)
          if (span) span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens)
        }
        if (span) {
          const msg = result.generations?.[0]?.message
          const responseId = msg?.response_metadata?.id || msg?.id
          if (responseId) span.setAttribute("gen_ai.response.id", responseId)
          if (msg?.tool_calls?.length > 0) {
            span.setAttribute(
              "gen_ai.response.tool_calls",
              JSON.stringify(msg.tool_calls.map((tc) => ({ name: tc.name, args: tc.args }))),
            )
          }
        }
        if (span && LOG._debug) {
          const output = JSON.stringify(result.generations?.[0]?.message?.content)
          span.setAttribute("gen_ai.output.messages", output)
          span.setAttribute("a2a.entity.output", output)
        }

        return result
      }

      if (tracer) {
        return tracer.startActiveSpan(
          `chat ${modelName}`,
          { kind: 3 /* SpanKind.CLIENT */ },
          async (span) => {
            try {
              return await invoke(span)
            } finally {
              span.end()
            }
          },
        )
      }
      return invoke(null)
    }
  }
  InstrumentedOrchestrationClient[INSTRUMENTED] = true

  const rawModel = new InstrumentedOrchestrationClient({
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
