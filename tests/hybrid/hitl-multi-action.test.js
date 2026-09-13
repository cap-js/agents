import cds from "@sap/cds"

const { POST } = cds.test(import.meta.dirname + "/../projects/bookshop")

function send(parts, { contextId, taskId } = {}) {
  return POST("/a2a/deterministic-hitl/", {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId: cds.utils.uuid(),
        role: "user",
        ...(contextId && { contextId }),
        ...(taskId && { taskId }),
        parts,
      },
    },
  })
}

describe("@cap-js/agents - deterministic multi-action HITL", () => {
  it("queues decisions until every action has one, then resumes production GraphExecutor", async () => {
    const contextId = cds.utils.uuid()
    const initial = await send([{ kind: "text", text: "start" }], { contextId })
    const task = initial.data.result
    expect(task.status.state).toBe("input-required")
    expect(task.status.message.metadata["sap.cds.agents.hitl"]).toMatchObject({
      actionCount: 2,
      decisions: [],
    })

    const first = await send([{ kind: "text", text: "approve" }], {
      contextId,
      taskId: task.id,
    })
    const waiting = first.data.result
    expect(waiting.status.state).toBe("input-required")
    expect(waiting.status.message.parts[0].text).toBe("Approve second action?")
    expect(waiting.status.message.metadata["sap.cds.agents.hitl"].decisions).toEqual([
      { type: "approve" },
    ])

    const complete = await send([{ kind: "text", text: "reject" }], {
      contextId,
      taskId: task.id,
    })
    expect(complete.data.result.status.state).toBe("completed")
  })
})
