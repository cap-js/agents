import cds from "@sap/cds"
import createHelpers from "../utils/helpers.js"

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")

describe("@cap-js/agents - HITL (CatalogService)", () => {
  const BOOK_ID = 201
  let sendMessage, jsonrpc

  async function getBookStock(id) {
    const book = await SELECT.one
      .from("sap.capire.bookshop.Books")
      .columns("stock")
      .where({ ID: id })
    return book?.stock
  }

  before(async () => {
    const helpers = createHelpers({ POST, axios })
    sendMessage = helpers.sendMessage
    jsonrpc = helpers.jsonrpc
  })

  it("tasks/cancel cancels task in input-required state", async () => {
    const stockBefore = await getBookStock(BOOK_ID)
    expect(stockBefore).not.toBe(undefined)

    // @agent.hitl on submitOrder should trigger HITL interrupt
    const res = await sendMessage("catalog", `Submit order for 2 copies of book ${BOOK_ID} hitl`)
    const state = res.data.result?.status?.state

    // LLM non-determinism: may not always call submitOrder action
    expect(state).toBe("input-required")

    const taskId = res.data.result.id
    const cancelRes = await jsonrpc("catalog", "tasks/cancel", { id: taskId })
    expect(cancelRes.data.result.status.state).toBe("canceled")

    const stockAfter = await getBookStock(BOOK_ID)
    expect(stockAfter).toBe(stockBefore)
  })

  it("HITL approval resumes task and decreases stock", async () => {
    const quantity = 1
    const stockBefore = await getBookStock(BOOK_ID)
    expect(stockBefore).not.toBe(undefined)

    const res = await sendMessage(
      "catalog",
      `Submit order for ${quantity} copies of book ${BOOK_ID} hitl`,
    )
    const state = res.data.result?.status?.state
    expect(state).toBe("input-required")

    const taskId = res.data.result.id
    const approveRes = await sendMessage("catalog", "yes", { taskId })
    expect(approveRes.data.result.id).toBe(taskId)
    expect(approveRes.data.result.status.state).toBe("completed")

    const stockAfter = await getBookStock(BOOK_ID)
    expect(stockAfter).toBe(stockBefore - quantity)
  })
})
