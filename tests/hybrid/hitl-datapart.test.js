// Hybrid smoke test: HITL DataPart carry (issue #199) — full suspend → resume round-trip vs. real LLM.

import path from "node:path"
import cds from "@sap/cds"

const { POST } = cds.test(path.join(import.meta.dirname, "../projects/bookshop"))

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

  it("resume side: edit decision injects an awareness note so the agent doesn't apologize", async () => {
    const contextId = cds.utils.uuid()

    // Trigger HITL asking for 3 copies.
    const triggerRes = await sendMessage(
      "catalog",
      [
        {
          kind: "text",
          text: "Please submit an order for 3 copies of book with ID 201. Go ahead and call submitOrder directly.",
        },
      ],
      { contextId },
    )

    expect(triggerRes.data.result?.status.state).toBe("input-required")
    const taskId = triggerRes.data.result.id

    // Ground "edited" args in what the model actually proposed (book id may vary).
    const parts = triggerRes.data.result.status.message?.parts || []
    const dataPart = parts.find((p) => p.kind === "data" && p.data !== undefined)
    expect(dataPart, "expected the interrupt to carry a DataPart").toBeTruthy()
    const original = dataPart.data.actionRequests?.[0]
    expect(original, "expected at least one actionRequest").toBeTruthy()
    expect(original.name).toBe("submitOrder")

    // Edit: bump quantity 3 → 4.
    const editedArgs = { ...original.args, quantity: 4 }
    const resumeRes = await sendMessage(
      "catalog",
      [
        {
          kind: "data",
          data: {
            decisions: [
              {
                type: "edit",
                editedAction: { name: "submitOrder", args: editedArgs },
              },
            ],
          },
        },
      ],
      { contextId, taskId },
    )

    expect(resumeRes.status).toBe(200)
    const result = resumeRes.data.result
    expect(result?.status.state).toBe("completed")

    // Final message must reflect the edited quantity and not apologize.
    const finalText = (result.status.message?.parts ?? [])
      .filter((p) => p.kind === "text" || p.text)
      .map((p) => p.text)
      .join(" ")

    expect(finalText, "expected a final agent message").toBeTruthy()
    expect(finalText).toMatch(/\b4\b/)
    expect(
      finalText,
      `agent should not apologize when the user edited a tool call — got: ${finalText}`,
    ).not.toMatch(/sorry|apolog|mistake|error on my/i)
  })
})
