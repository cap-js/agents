async function createAgentState() {
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
    iterations: Annotation({
      reducer: (_, v) => v,
      default: () => 0,
    }),
  })
}

module.exports = { createAgentState }
