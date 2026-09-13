import { createMiddleware } from "langchain"
import { HumanMessage } from "@langchain/core/messages"
import { z } from "zod"

// Injects user HITL decisions before the model continues after a rejection or edit.
export function hitlDecisionNoteInjectorMiddleware() {
  return createMiddleware({
    name: "hitlDecisionNoteInjectorMiddleware",
    stateSchema: z.object({ _hitlDecisionNote: z.string().optional() }),
    beforeModel: async (state) => {
      if (!state._hitlDecisionNote) return
      return {
        messages: [new HumanMessage(state._hitlDecisionNote)],
        _hitlDecisionNote: undefined,
      }
    },
  })
}
