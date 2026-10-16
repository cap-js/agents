import cds from "@sap/cds"
import { short } from "../../../lib/utils/utils.js"
import { convertUsageData } from "../../../lib/telemetry/chat-tracing.js"

export function aggregateUsageData(messages) {
  const result = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    reasoning_tokens: 0,
    context_tokens: 0,
  }
  for (const message of messages) {
    if (!message.usage_metadata) continue
    const usage = convertUsageData(message.usage_metadata)
    Object.keys(usage).forEach((key) => {
      if (key in result && usage[key] != null) result[key] += usage[key]
    })
    if (usage.input_tokens != null) {
      result.context_tokens = usage.input_tokens + (usage.output_tokens || 0)
    }
  }
  return result
}

function totalToolCalls(messages) {
  return messages.reduce((count, message) => count + (message.type === "tool" ? 1 : 0), 0)
}

export function recordUsage({ graph, result, usageData }) {
  const serviceName = cds.context?.["agent.service"]
  const contextId = cds.context?.["agent.context.id"]
  const taskId = cds.context?.["agent.task.id"]
  const log = cds.log("agents")
  cds.spawn(async () => {
    try {
      let messages = result?.messages
      if (!messages && graph?.checkpointer) {
        try {
          const thread_id = serviceName + ":" + contextId
          let checkpoint = await graph.checkpointer.getTuple({ configurable: { thread_id } })
          if (!checkpoint?.checkpoint?.channel_values && graph.checkpointer.latestNamespace) {
            const namespace = await graph.checkpointer.latestNamespace(thread_id)
            if (namespace) {
              checkpoint = await graph.checkpointer.getTuple({
                configurable: { thread_id, checkpoint_ns: namespace },
              })
            }
          }
          messages = checkpoint?.checkpoint?.channel_values?.messages
        } catch {
          /* best-effort */
        }
      }
      const updates = { agentService: serviceName }
      if (usageData?.total_tokens != null) {
        updates.usageLlmTokens = usageData.total_tokens
      } else if (messages) {
        const recovered = aggregateUsageData(messages)
        if (recovered?.total_tokens) updates.usageLlmTokens = recovered.total_tokens
      }
      if (messages) updates.usageToolCalls = totalToolCalls(messages)
      await UPDATE("cap.agent.Tasks").where({ taskId }).with(updates)
    } catch (error) {
      log.debug("usage update failed", { conversation: short(contextId), error: error.message })
    }
  })
}
