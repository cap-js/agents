import cds from "@sap/cds"
import { circuitBreaker, timeout } from "@sap-cloud-sdk/resilience"
import * as metrics from "./telemetry/metrics.js"
import { INSTRUMENTED } from "./telemetry/tracing.js"
import { audit } from "./utils.js"

import { SystemMessage, ToolMessage, HumanMessage } from "@langchain/core/messages"

const LOG = cds.log("a2a")

/**
 * deepagents' built-in tools (read_file, ls, grep, etc.) return content as
 * [{type: "text", text: "..."}] arrays (MCP-style content blocks).
 * SAP AI Core's orchestration API expects content as a plain string.
 * Without flattening, AI Core rejects the request with HTTP 400.
 */
export function flattenMessages(messages) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m
    // AIMessages may have tool_calls alongside content — leave those untouched
    if (m.tool_calls?.length > 0) return m
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n\n")
    if (ToolMessage.isInstance?.(m) || m._getType?.() === "tool") {
      return new ToolMessage({ content: text, tool_call_id: m.tool_call_id, name: m.name })
    }
    if (SystemMessage.isInstance?.(m) || m._getType?.() === "system") {
      return new SystemMessage(text)
    }
    if (HumanMessage.isInstance?.(m) || m._getType?.() === "human") {
      return new HumanMessage(text)
    }
    // Fallback: flatten content for any other message type
    return { ...m, content: text }
  })
}

/**
 * Build content filter configuration for the OrchestrationClient.
 * Resolution order:
 *   1. srv.a2a.contentFilter as async function → await fn()
 *   2. srv.a2a.contentFilter === false → disabled for this service
 *   3. srv.a2a.contentFilter as object → passthrough
 *   4. No srv override → fall back to cds.env.a2a.contentFilter:
 *      - falsy → disabled
 *      - object → passthrough
 *      - truthy (default: true) → Azure Content Safety with prompt_shield
 */
export async function buildContentFilter(srv) {
  const override = srv?.a2a?.contentFilter
  const disabled = undefined

  // Per-service override takes precedence
  if (override !== undefined) {
    if (typeof override === "function") return await override()
    if (override === false) return disabled
    if (typeof override === "object") return override
  }

  // Global config fallback
  if (!cds.env.a2a.contentFilter) return disabled
  if (typeof cds.env.a2a.contentFilter === "object") return cds.env.a2a.contentFilter

  // Default: Azure Content Safety with prompt injection shield
  const { buildAzureContentSafetyFilter } = await import("@sap-ai-sdk/orchestration")

  const inputFilter = buildAzureContentSafetyFilter("input", {
    hate: "ALLOW_SAFE_LOW",
    violence: "ALLOW_SAFE_LOW_MEDIUM",
    prompt_shield: true,
  })

  const outputFilter = buildAzureContentSafetyFilter("output", {
    hate: "ALLOW_SAFE",
    violence: "ALLOW_SAFE_LOW_MEDIUM",
  })
  return {
    input: { filters: [inputFilter] },
    output: { filters: [outputFilter] },
  }
}

/**
 * Creates an instrumented OrchestrationClient subclass.
 *
 * @param {object} options
 * @param {string} options.modelName - AI Core model name
 * @param {object} [options.params] - Model params (temperature, max_tokens, etc.)
 * @param {boolean} [options.flatten] - If true, flatten array-content messages before sending
 * @returns {import("@sap-ai-sdk/langchain").OrchestrationClient} InstrumentedOrchestrationClient subclass
 */
async function createInstrumentedClient({ modelName, params, flatten }) {
  const { OrchestrationClient } = await import("@sap-ai-sdk/langchain")
  class InstrumentedOrchestrationClient extends OrchestrationClient {
    async _generate(messages, opts, runManager) {
      const tracer = metrics.getTracer()
      const node = opts?.runName || (flatten ? "unknown" : "agent")
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
        const t0 = Date.now()
        try {
          const llmTimeout = cds.env.a2a?.pool?.maxLLMCallTimeoutMs || 120000
          opts = {
            ...opts,
            customRequestConfig: {
              ...opts?.customRequestConfig,
              middleware: [timeout(llmTimeout), circuitBreaker()],
            },
          }
          const inputMessages = flatten ? flattenMessages(messages) : messages
          result = await super._generate(inputMessages, opts, runManager)
        } catch (err) {
          const status = err.rootCause?.status
          const data = err.rootCause?.response?.data
          const headers = err.rootCause?.response?.headers
          const isFilterModule = /Filtering Module/i.test(data?.error?.location || "")
          const isExternalFailure = headers?.["ai-external-failure"] === "true"

          if (isFilterModule && status === 503 && isExternalFailure) {
            LOG.warn(
              "Content filter service rejected the request (likely payload too large for prompt_shield). " +
                "Disable input filter or content filtering for this service: " +
                "this.a2a = { contentFilter: false } — see README → Content Filter → Limitations.",
              {
                model: modelName,
                node,
                status,
                location: data?.error?.location,
                messageCount: messages.length,
              },
            )
          } else if (isFilterModule && status === 400) {
            // The input filter blocked the request (e.g. detected prompt injection).
            // Managed agents recover from this in lib/executor/langgraph/nodes/agent.js.
            // DeepAgents do not — see contentFilterRecoveryMiddleware for an opt-in fix.
            LOG.warn("Content filter blocked the request", {
              model: modelName,
              node,
              status,
              reason: data?.error?.message,
            })
          }
          metrics.llmInvocations.add(1, { ...mAttrs, outcome: "error" })
          if (span) {
            span.setAttribute("error.type", err.constructor?.name || "Error")
            span.setStatus({ code: 2, message: err.message })
          }
          throw err
        }
        const duration = Date.now() - t0

        metrics.llmInvocations.add(1, { ...mAttrs, outcome: "success" })
        // Only first entry can be used as multi generations do not happen with the Orchestration API
        const usage = result.generations?.[0]?.message?.usage_metadata
        if (usage?.input_tokens) {
          metrics.llmInputTokens.add(usage.input_tokens, mAttrs)
          if (span) span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens)
        }
        if (usage?.output_tokens) {
          metrics.llmOutputTokens.add(usage.output_tokens, mAttrs)
          if (span) span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens)
        }
        const msg = result.generations?.[0]?.message
        if (span) {
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

        // Audit: record agent decision (LLM invocation + tool selection)
        const taskId = opts?.configurable?._taskId || cds.context?.["a2a.task.id"]
        if (taskId) {
          audit("AgentDecision", {
            data: {
              taskId,
              contextId:
                opts?.configurable?.thread_id?.split(":")[1] || cds.context?.["a2a.context.id"],
              service: opts?.configurable?._service || cds.context?.["a2a.service"],
              model: modelName,
              iteration: opts?.configurable?._iteration ?? cds.context?.["a2a.iteration"],
              toolCalls: msg?.tool_calls?.map((tc) => ({ name: tc.name, args: tc.args })),
              inputTokens: usage?.input_tokens,
              outputTokens: usage?.output_tokens,
              duration,
            },
          })
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
  return InstrumentedOrchestrationClient
}

/**
 * Create an LLM model (OrchestrationClient from @sap-ai-sdk/langchain).
 *
 * Works for both managed agents (langgraph executor) and deepagents.
 * Set `deepAgent: true` for deepagent mode which enables message flattening
 * and skips tool binding.
 *
 * Resolution order for the model (managed agent only, i.e. deepAgent=false):
 *   1. srv.a2a.model as factory function (tools) => model
 *   2. srv.a2a.model as a LangChain BaseChatModel instance (plugin calls .bindTools)
 *   3. Default: OrchestrationClient from @sap-ai-sdk/langchain
 *
 * @param {object} [options]
 * @param {boolean} [options.deepAgent] - Deep agent mode: flatten=true, default params, no tool binding
 * @param {import("@sap/cds").Service} [options.srv] - CDS service (for custom model override + content filter)
 * @param {Array} [options.tools] - LangChain tools to bind (ignored when deepAgent=true)
 * @param {string} [options.name] - Model name (default: cds.env.a2a.llm || AICORE_MODEL)
 * @param {object} [options.params] - Model params (deepAgent default: { max_tokens: 4096, temperature: 0 })
 * @param {boolean} [options.flatten] - Override flatten behavior (deepAgent default: true, managed default: false)
 * @returns {Promise<import("@sap-ai-sdk/langchain").OrchestrationClient>} A LangChain-compatible chat model
 */
export async function createModel(options = {}) {
  const { srv, tools, deepAgent } = options

  // Custom model override (managed agent only)
  if (!deepAgent) {
    const override = srv?.a2a?.model

    if (typeof override === "function") {
      LOG.info("Using custom model factory", { service: srv?.name })
      return await override(tools)
    }

    if (override && typeof override.bindTools === "function") {
      LOG.info("Using custom model instance", { service: srv?.name })
      return tools && tools.length > 0 ? override.bindTools(tools) : override
    }
  }

  const modelName = options.name || cds.env.a2a?.llm || process.env.AICORE_MODEL
  if (!modelName) {
    throw new Error("No LLM model configured. Set cds.env.a2a.llm or AICORE_MODEL.")
  }

  const params =
    options.params || (deepAgent ? { max_tokens: 4096, temperature: 0 } : cds.env.a2a?.params)
  const flatten = options.flatten ?? (deepAgent ? true : false)

  LOG.debug("Initializing LLM", { model: modelName, deepAgent: !!deepAgent })

  const Client = await createInstrumentedClient({ modelName, params, flatten })
  const filtering = await buildContentFilter(srv)

  const rawModel = new Client(
    {
      promptTemplating: { model: { name: modelName, params } },
      ...(filtering && { filtering }),
    },
    {
      onFailedAttempt: (err) => {
        // Abort retries when circuit breaker is open (otherwise pRetry delays ~30-60s)
        if (err.code === "EOPENBREAKER" || err.message === "Breaker is open") {
          throw err
        }
      },
    },
  )

  if (!deepAgent && tools && tools.length > 0) {
    return rawModel.bindTools(tools)
  }
  return rawModel
}

/**
 * Create an LLM model for use with deepagents (createDeepAgent).
 *
 * Thin wrapper around createModel({ deepAgent: true }) that enables:
 *   - Message flattening: deepagents' built-in tools (read_file, ls, grep, etc.)
 *     return content as [{type:"text",text:"..."}] arrays. SAP AI Core requires
 *     plain strings — flattenMessages() converts them before each LLM call.
 *   - Default params: { max_tokens: 4096, temperature: 0 } unless overridden.
 *   - No tool binding: deepagents manages its own tool execution.
 *
 * @param {object} [options]
 * @param {string} [options.name] - Model name (default: cds.env.a2a.llm)
 * @param {object} [options.params] - Model params (default: { max_tokens: 4096, temperature: 0 })
 * @returns {Promise<import("@sap-ai-sdk/langchain").OrchestrationClient>}
 */
export async function createDeepAgentModel(options = {}) {
  return createModel({ ...options, deepAgent: true })
}
