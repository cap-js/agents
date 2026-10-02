import { createMiddleware } from "langchain"
import { HumanMessage } from "@langchain/core/messages"
import { z } from "zod"

// Injects user HITL decisions before the model continues after a rejection or edit.
//
// LangChain's humanInTheLoopMiddleware returns `jumpTo: "model"` for reject/edit
// decisions, which re-enters the model node directly and SKIPS all `beforeModel`
// hooks. `wrapModelCall`, however, still runs on that jump — so the note must be
// injected there, not in `beforeModel`.
//
// The note is one-shot: it is set via a Command state update when a HITL task is
// resumed. `wrapModelCall` cannot update graph state, so a companion `beforeModel`
// hook clears it on the next normal turn to prevent re-injection.
export function hitlDecisionNoteInjectorMiddleware() {
  return createMiddleware({
    name: "hitlDecisionNoteInjectorMiddleware",
    stateSchema: z.object({ _hitlDecisionNote: z.string().optional() }),
    wrapModelCall: async (request, handler) => {
      const note = request.state?._hitlDecisionNote
      if (!note) return handler(request)
      return handler({ ...request, messages: [...(request.messages || []), new HumanMessage(note)] })
    },
    beforeModel: async (state) => {
      if (!state._hitlDecisionNote) return
      return { _hitlDecisionNote: undefined }
    },
  })
}
