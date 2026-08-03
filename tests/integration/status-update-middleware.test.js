import assert from "node:assert/strict"
import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")
import createHelpers from "../utils/helpers.js"
const { streamMessage, parseSSEFrames, setupErrorDetection } = createHelpers({ POST, axios })

describe("@cap-js/agents - Status Update Middleware", () => {
  setupErrorDetection()

  // LoopingService uses createAgent with full middleware pipeline and mock model
  // that always produces tool_calls → exercises afterModel and beforeModel hooks.
  function streamToLooping(text) {
    return POST(
      "/a2a/looping/",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "message/stream",
        params: {
          message: {
            kind: "message",
            messageId: cds.utils.uuid(),
            role: "user",
            parts: [{ kind: "text", text }],
          },
        },
      },
      { responseType: "text" },
    )
  }

  it("emits working status-update with entity label for query tool", async () => {
    const res = await streamToLooping("test")
    const frames = parseSSEFrames(res.data)

    // LoopingService always calls "query" tool → should emit "Querying ..."
    const queryingFrames = frames.filter((f) => {
      const text = f.result?.status?.message?.parts?.[0]?.text || ""
      return f.result?.kind === "status-update" && !f.result.final && text.startsWith("Querying ")
    })

    assert.ok(queryingFrames.length > 0, `expected at least one "Querying ..." status-update frame`)

    // Verify entity label is resolved (not raw entity name "Books" is fine as label)
    const text = queryingFrames[0].result.status.message.parts[0].text
    assert.ok(text.length > "Querying ".length, `expected entity label in: "${text}"`)
  })

  it("emits 'Processing tool response' (singular) for single tool call", async () => {
    const res = await streamToLooping("test")
    const frames = parseSSEFrames(res.data)

    const processingFrames = frames.filter((f) => {
      const text = f.result?.status?.message?.parts?.[0]?.text || ""
      return text.includes("Processing tool response")
    })

    assert.ok(
      processingFrames.length > 0,
      'expected "Processing tool response" status-update after tool execution',
    )

    // LoopingService calls one tool per iteration → singular
    const text = processingFrames[0].result.status.message.parts[0].text
    assert.strictEqual(text, "Processing tool response")
  })

  it("status messages use resolved i18n labels (not raw keys)", async () => {
    const res = await streamToLooping("test")
    const frames = parseSSEFrames(res.data)

    const statusMsgs = frames
      .filter(
        (f) =>
          f.result?.kind === "status-update" &&
          !f.result.final &&
          f.result.status?.message?.parts?.[0]?.text,
      )
      .map((f) => f.result.status.message.parts[0].text)

    for (const msg of statusMsgs) {
      assert.ok(!msg.includes("agent_status_"), `raw i18n key leaked: "${msg}"`)
    }
  })

  describe("SQL format query tool", () => {
    function streamToLoopingSql(text) {
      return POST(
        "/a2a/looping-sql/",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "message/stream",
          params: {
            message: {
              kind: "message",
              messageId: cds.utils.uuid(),
              role: "user",
              parts: [{ kind: "text", text }],
            },
          },
        },
        { responseType: "text" },
      )
    }

    it("emits working status-update with entity label for SQL-format query tool", async () => {
      const res = await streamToLoopingSql("test")
      const frames = parseSSEFrames(res.data)

      const queryingFrames = frames.filter((f) => {
        const text = f.result?.status?.message?.parts?.[0]?.text || ""
        return f.result?.kind === "status-update" && !f.result.final && text.startsWith("Querying ")
      })

      assert.ok(
        queryingFrames.length > 0,
        `expected at least one "Querying ..." status-update frame`,
      )

      // Entity label resolved from fully-qualified SQL — not raw tool name "query"
      const text = queryingFrames[0].result.status.message.parts[0].text
      assert.ok(text.length > "Querying ".length, `expected entity label in: "${text}"`)
      assert.notStrictEqual(text, "Querying query", `label should not fall back to raw tool name`)
    })
  })

  it("non-final status-updates have proper A2A event shape", async () => {
    const res = await streamToLooping("test")
    const frames = parseSSEFrames(res.data)

    const workingWithMsg = frames.filter(
      (f) => f.result?.kind === "status-update" && !f.result.final && f.result.status?.message,
    )

    assert.ok(workingWithMsg.length > 0, "expected non-final status-update frames with message")

    for (const frame of workingWithMsg) {
      const event = frame.result
      assert.strictEqual(event.kind, "status-update")
      assert.strictEqual(event.final, false)
      assert.strictEqual(event.status.state, "working")
      assert.ok(event.taskId, "should have taskId")
      assert.ok(event.contextId, "should have contextId")
      assert.strictEqual(event.status.message.role, "agent")
      assert.ok(event.status.message.messageId, "should have messageId")
      assert.ok(event.status.message.parts[0].text, "should have text")
    }
  })
})
