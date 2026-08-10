// Hybrid smoke test: HITL DataPart carry (issue #199)
//
// Exercises the full suspend → DataPart resume round-trip against a real LLM:
//   1. Trigger a message that causes the agent to call `submitOrder` (annotated @agent.hitl)
//   2. Assert the input-required response carries BOTH a TextPart and a DataPart
//   3. Resume with a structured DataPart ({ decisions: [{ type: "approve" }] })
//   4. Assert the task completes (rather than misrouting to reject)

import path from "node:path"
import cds from "@sap/cds"

const { POST } = cds.test(path.join(import.meta.dirname, "../samples/bookshop"))

function sendMessage(service, parts, { contextId, taskId } = {}) {
  return POST(`/a2a/${service}/`, {
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

describe("@cap-js/agents - HITL DataPart carry (issue #199)", () => {
  it("suspend side: input-required status carries a DataPart alongside the TextPart", async () => {
    const contextId = cds.utils.uuid()

    const res = await sendMessage(
      "catalog",
      [
        {
          kind: "text",
          text: "Please submit an order for 1 copy of book with ID 201. Go ahead and call submitOrder directly.",
        },
      ],
      { contextId },
    )

    expect(res.status).toBe(200)
    const result = res.data.result
    expect(result, "expected a task result").toBeTruthy()
    expect(result.status.state).toBe("input-required")

    const parts = result.status.message?.parts || []
    const textPart = parts.find((p) => p.kind === "text" || p.text)
    const dataPart = parts.find((p) => p.kind === "data" && p.data !== undefined)

    expect(textPart, "input-required message must have a TextPart").toBeTruthy()
    expect(
      dataPart,
      "input-required message must carry a DataPart with the raw interrupt payload",
    ).toBeTruthy()

    // The DataPart must carry the deepagents actionRequests payload
    expect(dataPart.data).toHaveProperty("actionRequests")
    expect(Array.isArray(dataPart.data.actionRequests)).toBe(true)
  })

  it("resume side: DataPart resume reaches the graph as-is and results in task completion", async () => {
    const contextId = cds.utils.uuid()

    // Step 1: trigger HITL
    const triggerRes = await sendMessage(
      "catalog",
      [
        {
          kind: "text",
          text: "Please submit an order for 1 copy of book with ID 201. Go ahead and call submitOrder directly.",
        },
      ],
      { contextId },
    )

    expect(triggerRes.data.result?.status.state).toBe("input-required")
    const taskId = triggerRes.data.result.id

    // Step 2: resume with a structured DataPart (approve)
    const resumeRes = await sendMessage(
      "catalog",
      [
        {
          kind: "data",
          data: { decisions: [{ type: "approve" }] },
        },
      ],
      { contextId, taskId },
    )

    expect(resumeRes.status).toBe(200)
    const result = resumeRes.data.result
    expect(result, "expected a task result on resume").toBeTruthy()
    expect(result.status.state).toBe("completed")
  })

  it("resume side: plain-text 'approve' still works (backward-compatibility check)", async () => {
    const contextId = cds.utils.uuid()

    const triggerRes = await sendMessage(
      "catalog",
      [
        {
          kind: "text",
          text: "Please submit an order for 1 copy of book with ID 201. Go ahead and call submitOrder directly.",
        },
      ],
      { contextId },
    )

    expect(triggerRes.data.result?.status.state).toBe("input-required")
    const taskId = triggerRes.data.result.id

    const resumeRes = await sendMessage("catalog", [{ kind: "text", text: "approve" }], {
      contextId,
      taskId,
    })

    expect(resumeRes.data.result?.status.state).toBe("completed")
  })

  it("resume side: DataPart reject keeps the task completed (not an error)", async () => {
    const contextId = cds.utils.uuid()

    const triggerRes = await sendMessage(
      "catalog",
      [
        {
          kind: "text",
          text: "Please submit an order for 1 copy of book with ID 201. Go ahead and call submitOrder directly.",
        },
      ],
      { contextId },
    )

    expect(triggerRes.data.result?.status.state).toBe("input-required")
    const taskId = triggerRes.data.result.id

    const resumeRes = await sendMessage(
      "catalog",
      [
        {
          kind: "data",
          data: { decisions: [{ type: "reject", message: "Not now" }] },
        },
      ],
      { contextId, taskId },
    )

    // Reject should complete the task (graph continues, action skipped), not error it
    expect(resumeRes.data.result?.status.state).toBe("completed")
  })
})
