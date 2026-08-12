import { createMiddleware } from "langchain"
import { HumanMessage } from "@langchain/core/messages"
import { z } from "zod"

// Injects a HumanMessage for a pending _hitlEditNote before the next model turn.
export function hitlEditNoteInjectorMiddleware() {
  return createMiddleware({
    name: "hitlEditNoteInjectorMiddleware",
    stateSchema: z.object({ _hitlEditNote: z.string().optional() }),
    beforeModel: async (state) => {
      if (!state._hitlEditNote) return
      return {
        messages: [new HumanMessage(state._hitlEditNote)],
        _hitlEditNote: undefined,
      }
    },
  })
}
