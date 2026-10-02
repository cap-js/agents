import { createMiddleware } from "langchain"
import { HumanMessage } from "@langchain/core/messages"
import { z } from "zod"

// Injects user HITL decisions (edit/reject) as a HumanMessage before the model
// continues, so the model treats them as deliberate user decisions rather than
// tool failures.
//
// Two hooks are needed because LangChain's humanInTheLoopMiddleware routes the two
// decision types differently (see its `jumpTo = hasRejectedToolCalls ? "model" : undefined`):
//
//   - edit   → jumpTo undefined → normal flow → `beforeModel` runs. Inject + clear here.
//   - reject → jumpTo "model"  → re-enters the model node directly, SKIPPING all
//              `beforeModel` hooks. `wrapModelCall` still runs, so it injects as a
//              fallback when `beforeModel` did not consume the note.
//
// For edit, `beforeModel` clears the one-shot note so `wrapModelCall` does not
// re-inject it; for reject, the note survives to `wrapModelCall`.
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
    wrapModelCall: async (request, handler) => {
      const note = request.state?._hitlDecisionNote
      if (!note) return handler(request)
      return handler({ ...request, messages: [...(request.messages || []), new HumanMessage(note)] })
    },
  })
}
