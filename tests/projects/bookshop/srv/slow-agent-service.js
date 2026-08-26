import cds from "@sap/cds"

/**
 * Test-only agent used by tests/integration/client-disconnect.test.js.
 *
 * Returns a compiled LangGraph whose single node awaits until either the
 * AbortSignal fires (client disconnect) or a long timeout elapses. This lets
 * the test reliably assert that the server-side disconnect handler propagates
 * the abort to the graph via GraphExecutor.
 */
export default class SlowAgentService extends cds.ApplicationService {
  init() {
    this.on("buildGraph", async () => this._buildGraph())
    return super.init()
  }

  async _buildGraph() {
    const { StateGraph, Annotation, messagesStateReducer } = await import("@langchain/langgraph")
    const { AIMessage } = await import("@langchain/core/messages")

    const GraphState = Annotation.Root({
      messages: Annotation({ reducer: messagesStateReducer }),
      output: Annotation({ reducer: (_, v) => v }),
    })

    async function slowNode(_state, config) {
      // Wait until the caller aborts the config.signal. If nothing aborts,
      // give up after 10s so a broken test doesn't hang the runner.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 10_000)
        const signal = config?.signal
        if (!signal) return
        if (signal.aborted) {
          clearTimeout(timer)
          reject(new DOMException("The operation was aborted", "AbortError"))
          return
        }
        signal.addEventListener("abort", () => {
          clearTimeout(timer)
          reject(new DOMException("The operation was aborted", "AbortError"))
        })
      })
      const response = new AIMessage("slow node completed")
      return { messages: [response], output: response.content }
    }

    const graph = new StateGraph(GraphState)
      .addNode("slow", slowNode)
      .addEdge("__start__", "slow")
      .addEdge("slow", "__end__")

    return graph.compile()
  }
}
