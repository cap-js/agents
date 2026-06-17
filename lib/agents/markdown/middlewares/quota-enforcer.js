import cds from "@sap/cds"
import { audit } from "../../../utils/utils.js"
import { createMiddleware } from "langchain"
import { AIMessage } from "@langchain/core/messages"
import { z } from "zod"

/**
 * Quota enforcement middlewares for deep agents.
 * Reads limits from cds.env.agents.pool at check time (not creation time).
 * Returns array to spread into middleware config.
 */
export async function quotaEnforcerMiddleware() {
  return [
    createMiddleware({
      name: "agentQuotaEnforcerMiddleware",
      stateSchema: z.object({
        runModelCallCount: z.number().default(0),
        runTokenCount: z.number().default(0),
        runToolCallCount: z.number().default(0),
      }),
      afterModel: {
        canJumpTo: ["end"],
        hook: (state) => {
          const pool = cds.env.agents?.pool || {}
          const newCallCount = state.runModelCallCount + 1

          // Check LLM invocation limit
          if (pool.maxLLMInvocationsPerTask && newCallCount >= pool.maxLLMInvocationsPerTask) {
            const reason = `LLM call limit exceeded: ${newCallCount} calls (max ${pool.maxLLMInvocationsPerTask} per task)`
            audit("QuotaExceeded", {
              data: {
                service: cds.context?.["agent.service"],
                user: cds.context?.user?.id,
                reason,
                taskId: cds.context?.["agent.task.id"],
              },
            })
            throw new Error(reason)
          }

          // Accumulate token usage
          const lastAI = [...state.messages].reverse().find(AIMessage.isInstance)
          const usage = lastAI?.usage_metadata
          const consumed = (usage?.input_tokens || 0) + (usage?.output_tokens || 0)
          const newTokenCount = state.runTokenCount + consumed

          // Check token limit
          if (pool.maxLLMTokensPerTask && newTokenCount >= pool.maxLLMTokensPerTask) {
            const reason = `Token limit exceeded: ${newTokenCount} tokens (max ${pool.maxLLMTokensPerTask} per task)`
            audit("QuotaExceeded", {
              data: {
                service: cds.context?.["agent.service"],
                user: cds.context?.user?.id,
                reason,
                taskId: cds.context?.["agent.task.id"],
              },
            })
            throw new Error(reason)
          }

          // Count tool calls from latest AI message
          const toolCalls = lastAI?.tool_calls?.length || 0
          const newToolCallCount = state.runToolCallCount + toolCalls

          // Check tool call limit
          if (pool.maxToolCallsPerTask && newToolCallCount >= pool.maxToolCallsPerTask) {
            const reason = `Tool call limit exceeded: ${newToolCallCount} calls (max ${pool.maxToolCallsPerTask} per task)`
            audit("QuotaExceeded", {
              data: {
                service: cds.context?.["agent.service"],
                user: cds.context?.user?.id,
                reason,
                taskId: cds.context?.["agent.task.id"],
              },
            })
            throw new Error(reason)
          }

          return {
            runModelCallCount: newCallCount,
            runTokenCount: newTokenCount,
            runToolCallCount: newToolCallCount,
          }
        },
      },
      afterAgent: () => ({ runModelCallCount: 0, runTokenCount: 0, runToolCallCount: 0 }),
    }),
  ]
}
