import cds from "@sap/cds"
import { Annotation, interrupt, StateGraph } from "@langchain/langgraph"
import { AIMessage, ToolMessage } from "@langchain/core/messages"

const ACTION_REQUESTS = [
  {
    id: cds.utils.uuid(),
    name: "firstAction",
    description: "Approve first action?",
    args: { id: 1 },
  },
  {
    id: cds.utils.uuid(),
    name: "secondAction",
    description: "Approve second action?",
    args: { id: 2 },
  },
]

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
      .addNode("request", () => ({
        messages: [new AIMessage({ content: "", tool_calls: ACTION_REQUESTS })],
      }))
      .addNode("review", () => {
        const decisions = interrupt({
          actionRequests: ACTION_REQUESTS,
        })
        return {
          messages: [
            ...ACTION_REQUESTS.map(
              (action) =>
                new ToolMessage({
                  content: JSON.stringify(decisions),
                  name: action.name,
                  tool_call_id: action.id,
                }),
            ),
            new AIMessage({ content: JSON.stringify(decisions) }),
          ],
        }
      })
      .addEdge("__start__", "request")
      .addEdge("request", "review")
      .addEdge("review", "__end__")
    return graph.compile()
  }
}
