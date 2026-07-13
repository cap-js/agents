import cds from "@sap/cds"
import { StateGraph, Annotation, messagesStateReducer } from "@langchain/langgraph"
import { AIMessage } from "@langchain/core/messages"

/**
 * Minimal echo agent for @requires enforcement testing.
 * - Echoes user message prefixed with "Admin echo:"
 * - Reads cds.context.user.id and queries Books by createdBy to verify context propagation.
 */
export default class RestrictedAgentService extends cds.ApplicationService {
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

      // Verify cds.context.user survives through the graph chain via CDS query
      // This mimics how @restrict where:'createdBy=$user' resolves at runtime
      const userId = cds.context?.user?.id || "unknown"
      const { Books } = srv.entities
      const books = await SELECT.from(Books).where({ createdBy: userId })
      // books may be empty — that's fine, the point is CDS resolved $user correctly
      const output = `Admin echo: ${text} [user=${userId}, query_ran=true, books=${books.length}]`
      return {
        messages: [new AIMessage(output)],
        output,
      }
    }

    return new StateGraph(GraphState)
      .addNode("echo", echoNode)
      .addEdge("__start__", "echo")
      .addEdge("echo", "__end__")
      .compile()
  }
}
