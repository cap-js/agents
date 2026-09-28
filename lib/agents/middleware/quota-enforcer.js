import { createMiddleware } from "langchain"
import { z } from "zod"
import { quotaEnforcerAtNode, quotaEnforcerAtStart } from "../quota-handling.js"

/**
 * Quota enforcement middleware for deep agents.
 * Reads limits from cds.env.agents.quotas at check time (not creation time).
 * Returns array to spread into middleware config.
 */
export async function quotaEnforcerMiddleware() {
  return [
    createMiddleware({
      name: "quotaEnforcement",
      stateSchema: z.object({
        runModelCallCount: z.number().default(0),
        runTokenCount: z.number().default(0),
        runToolCallCount: z.number().default(0),
      }),
      beforeAgent: {
        hook: async (state) => {
          if (!state.messages.some((m) => m.type === "ai")) {
            await quotaEnforcerAtStart()
          }
        },
      },
      afterModel: {
        hook: async (state) => {
          return await quotaEnforcerAtNode(state)
        },
      },
      afterAgent: {
        hook: () => {
          return {
            runModelCallCount: 0,
            runTokenCount: 0,
            runToolCallCount: 0,
          }
        },
      },
    }),
  ]
}
