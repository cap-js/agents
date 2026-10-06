import cds from "@sap/cds"
import { Annotation, interrupt, StateGraph } from "@langchain/langgraph"
import { AIMessage } from "@langchain/core/messages"

export default class DeterministicHitlService extends cds.ApplicationService {
  init() {
    this.on("buildGraph", () => this._buildGraph())
    return super.init()
  }

  _buildGraph() {
    const GraphState = Annotation.Root({
      messages: Annotation({ reducer: (current = [], update = []) => [...current, ...update] }),
    })
    const graph = new StateGraph(GraphState)
      .addNode("review", () => {
        const decisions = interrupt({
          actionRequests: [
            { name: "firstAction", description: "Approve first action?", args: { id: 1 } },
            { name: "secondAction", description: "Approve second action?", args: { id: 2 } },
          ],
        })
        return { messages: [new AIMessage({ content: JSON.stringify(decisions) })] }
      })
      .addEdge("__start__", "review")
      .addEdge("review", "__end__")
    return graph.compile()
  }
}
