import cds from "@sap/cds"
import { Annotation, messagesStateReducer, StateGraph } from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { AIMessage } from "@langchain/core/messages"
import { humanInTheLoopMiddleware, tool } from "langchain"
import { z } from "zod"

export default class DeterministicHitlService extends cds.ApplicationService {
  init() {
    this.on("buildGraph", () => this._buildGraph())
    return super.init()
  }

  _buildGraph() {
    const names = ["firstAction", "secondAction"]
    const tools = new ToolNode(
      names.map((name) => tool(() => "executed", { name, schema: z.object({ id: z.number() }) })),
    )
    const hitl = humanInTheLoopMiddleware({
      interruptOn: {
        firstAction: {
          description: "Approve first action?",
          allowedDecisions: ["approve", "reject"],
        },
        secondAction: {
          description: "Approve second action?",
          allowedDecisions: ["approve", "reject"],
        },
      },
    })
    const GraphState = Annotation.Root({
      messages: Annotation({ reducer: messagesStateReducer }),
    })
    const graph = new StateGraph(GraphState)
      .addNode("request", () => ({
        messages: [
          new AIMessage({
            content: "",
            tool_calls: names.map((name, index) => ({
              id: cds.utils.uuid(),
              name,
              args: { id: index + 1 },
            })),
          }),
        ],
      }))
      .addNode("review", async (state) => {
        // Exercise the real approval hook without a model.
        const reviewed = await hitl.afterModel.hook(state, { context: {} })
        return { messages: reviewed?.messages ?? [] }
      })
      .addNode("execute", async (state, config) => {
        const requested = state.messages.findLast((m) => m.tool_calls?.length)
        // Rejected calls already have tool responses and must not execute.
        const answered = new Set(state.messages.map((m) => m.tool_call_id).filter(Boolean))
        const pending = requested.tool_calls.filter((call) => !answered.has(call.id))
        if (!pending.length) return { messages: [] }
        return tools.invoke(
          { messages: [new AIMessage({ content: "", tool_calls: pending })] },
          config,
        )
      })
      .addNode("respond", () => ({ messages: [new AIMessage("Actions reviewed.")] }))
      .addEdge("__start__", "request")
      .addEdge("request", "review")
      .addEdge("review", "execute")
      .addEdge("execute", "respond")
      .addEdge("respond", "__end__")
    return graph.compile()
  }
}
