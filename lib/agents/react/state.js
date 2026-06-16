/**
 * LangGraph agent state schema.
 *
 * Each channel has a reducer that controls how new values merge with existing ones:
 * - messages: append reducer (messagesStateReducer) — accumulates full conversation history
 * - output: last-write-wins — current agent response text
 * - toolCalls: last-write-wins — tool calls from current iteration (reset each loop)
 * - iterations: last-write-wins — loop counter for safety guard
 * - _totalTokens: accumulator — sums LLM token usage across all iterations
 *
 * Note: taskId and service name are passed via config.configurable (not state)
 * to avoid polluting checkpointed state with request-specific metadata.
 */
export async function createAgentState() {
  const { Annotation, messagesStateReducer } = await import("@langchain/langgraph")

  return Annotation.Root({
    messages: Annotation({
      reducer: messagesStateReducer,
      default: () => [],
    }),
    output: Annotation({
      reducer: (_, v) => v,
      default: () => "",
    }),
    toolCalls: Annotation({
      reducer: (_, v) => v,
      default: () => [],
    }),
    _iterations: Annotation({
      reducer: (_, v) => v,
      default: () => 0,
    }),
    _totalTokens: Annotation({
      reducer: (a, b) => a + b,
      default: () => 0,
    }),
    _totalToolCalls: Annotation({
      reducer: (a, b) => a + b,
      default: () => 0,
    }),
  })
}
