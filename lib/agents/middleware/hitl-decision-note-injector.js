import { createMiddleware } from "langchain"
import { HumanMessage } from "@langchain/core/messages"
import { z } from "zod"

// Injects user HITL decisions (edit/reject) as a HumanMessage before the model
// continues, so the model treats them as deliberate user decisions rather than
// tool failures.
//
// LangChain's humanInTheLoop middleware routes these decisions differently:
//   - edit   → jumpTo undefined → normal flow → `beforeModel` runs. Inject + clear here.
//   - reject → jumpTo "model"  → re-enters the model node directly, SKIPPING all
//              `beforeModel` hooks. `wrapModelCall` still runs, so it injects as a
//              fallback when `beforeModel` did not consume the note.
//
// So we use `wrapModel` to inject the message and clear the note after the model call.
export function hitlDecisionNoteInjectorMiddleware() {
  return createMiddleware({
    name: "hitlDecisionNoteInjectorMiddleware",
    stateSchema: z.object({ _hitlDecisionNote: z.string().optional() }),
    wrapModelCall: async (request, handler) => {
      const note = request.state?._hitlDecisionNote
      if (!note) return handler(request)
      return handler({
        ...request,
        messages: [...(request.messages || []), new HumanMessage(note)],
      })
    },
    afterModel: async (state) => {
      if (!state._hitlDecisionNote) return
      return { _hitlDecisionNote: undefined }
    },
  })
}
