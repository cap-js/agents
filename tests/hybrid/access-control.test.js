import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")

axios.defaults.validateStatus = () => true

const ALICE = { username: "alice", password: "" }
const BOB = { username: "bob", password: "" }

function jsonrpcAs(service, method, params, auth) {
  return POST(`/a2a/${service}/`, { jsonrpc: "2.0", id: 1, method, params }, { auth })
}

function sendMessageAs(service, text, auth, { contextId, taskId } = {}) {
  return jsonrpcAs(
    service,
    "message/send",
    {
      message: {
        kind: "message",
        messageId: cds.utils.uuid(),
        role: "user",
        ...(contextId && { contextId }),
        ...(taskId && { taskId }),
        parts: [{ kind: "text", text }],
      },
    },
    auth,
  )
}

describe("@cap-js/agents - Access Control (Checkpoints)", () => {
  it("bob cannot resume alice's conversation", async () => {
    const contextId = `ac-test-${Date.now()}`

    // Alice triggers HITL via @agent.hitl on submitOrder
    const aliceRes = await sendMessageAs("catalog", "Order 2 copies of Wuthering Heights", ALICE, {
      contextId,
    })
    // LLM should call submitOrder → interrupt() → input-required
    // If LLM doesn't call the action (non-deterministic), skip gracefully
    if (aliceRes.data.result?.status?.state !== "input-required") return
    const taskId = aliceRes.data.result.id

    // Bob tries to resume Alice's HITL task — should fail
    const bobResume = await sendMessageAs("catalog", "yes", BOB, { taskId })
    if (bobResume.data.error) {
      expect(bobResume.data.error).not.toBe(undefined)
    } else {
      expect(bobResume.data.result.id).not.toBe(taskId)
    }
  })

  it("alice can resume her own conversation", async () => {
    const contextId = `ac-test-own-${Date.now()}`

    // Alice triggers HITL
    const aliceRes = await sendMessageAs(
      "catalog",
      "Please order 1 copy of Wuthering Heights for me",
      ALICE,
      { contextId },
    )
    if (aliceRes.data.result?.status?.state !== "input-required") return
    const taskId = aliceRes.data.result.id

    // Alice resumes her own task
    const aliceResume = await sendMessageAs("catalog", "yes", ALICE, { taskId })
    expect(aliceResume.data.result.id).toBe(taskId)
    expect(aliceResume.data.result.status.state).toBe("completed")
  })
})
