import cds from "@sap/cds"
import { StateGraph, Annotation, messagesStateReducer } from "@langchain/langgraph"
import { AIMessage } from "@langchain/core/messages"

/**
 * Minimal echo agent for `@restrict` with `to: 'admin'` testing.
 * Parity with RestrictedAgentService (`@requires: 'admin'`).
 */
export default class RestrictAdminService extends cds.ApplicationService {
  init() {
    this.on("buildGraph", async () => this._buildGraph())
    return super.init()
  }

  async _buildGraph() {
    const srv = this

    const GraphState = Annotation.Root({
      messages: Annotation({ reducer: messagesStateReducer }),
      output: Annotation({ reducer: (_, v) => v }),
    })

    async function echoNode(state) {
      const lastMsg = state.messages[state.messages.length - 1]
      const text = lastMsg?.content || "echo"
      const userId = cds.context?.user?.id || "unknown"
      const { Books } = srv.entities
      const books = await SELECT.from(Books).where({ createdBy: userId })
      const output = `AdminRestrict echo: ${text} [user=${userId}, query_ran=true, books=${books.length}]`
      return { messages: [new AIMessage(output)], output }
    }

    return new StateGraph(GraphState)
      .addNode("echo", echoNode)
      .addEdge("__start__", "echo")
      .addEdge("echo", "__end__")
      .compile()
  }
}
