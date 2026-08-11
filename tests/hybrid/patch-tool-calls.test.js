/**
 * Regression test for dangling tool call patching after quota cancellation.
 *
 * When a task is canceled mid-flight (quota exceeded while a tool call is
 * pending), the checkpoint history ends with an AIMessage that has tool_calls
 * but no matching ToolMessage. Sending that
 * history to AI Core on the next turn causes a 400 error.
 *
 */
import assert from "node:assert/strict"
import cds from "@sap/cds"
import createHelpers from "../utils/helpers.js"

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
const { sendMessage } = createHelpers({ POST, axios })

describe("@cap-js/agents - patch-tool-calls middleware (hybrid)", () => {
  let origTokensPerTask

  before(() => {
    cds.env.agents ??= {}
    cds.env.agents.pool ??= {}
    origTokensPerTask = cds.env.agents.pool.maxLLMTokensPerTask
  })

  afterEach(() => {
    cds.env.agents.pool.maxLLMTokensPerTask = origTokensPerTask
  })

  it("follow-up message succeeds after first turn was canceled due to quota exceeded", async () => {
    const contextId = `patch-tool-calls-${Date.now()}`

    cds.env.agents.pool.maxLLMTokensPerTask = 20
    const res1 = await sendMessage("catalog", "Show me all books", { contextId })
    assert.strictEqual(
      res1.data.result.status.state,
      "canceled",
      "expected first turn to be canceled by quota",
    )

    cds.env.agents.pool.maxLLMTokensPerTask = origTokensPerTask
    const res2 = await sendMessage("catalog", "Just say hello", { contextId })
    assert.notStrictEqual(
      res2.data.result.status.state,
      "failed",
      `expected follow-up to not fail with 400; got state=${res2.data.result.status.state}, ` +
        `message=${res2.data.result.status.message?.parts?.[0]?.text}`,
    )
    assert.strictEqual(
      res2.data.result.status.state,
      "completed",
      "expected follow-up to complete successfully after quota was lifted",
    )
  }, 60000)
})
