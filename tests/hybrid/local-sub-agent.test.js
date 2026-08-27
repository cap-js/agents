/**
 * Local (in-process) sub-agent delegation — hybrid executor (real LLM via AI Core).
 * Run with: npm run test:hybrid
 *
 * Exercises buildSubAgentToolLocally: CatalogService (a standard ReAct agent)
 * delegates to GraphBookService, a peer @agent in the SAME CDS model with no
 * cds.requires credentials. The sub-agent is driven in its own detached
 * transaction (cds.spawn), independent of the calling agent's tx.
 *
 * Regression guard for two coupled bugs:
 *   1. A nested sub-agent sharing the parent's tx wrote checkpoints not yet
 *      visible to the executor's post-stream recovery read → null final state.
 *   2. GraphBookService's custom StateGraph persists its reduced state under a
 *      nested checkpoint_ns ("tools:…"), which the executor's recovery (default
 *      ns="") missed → defaultOutputMapper(null) threw
 *      "Cannot read properties of null (reading 'messages')".
 */
import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
import createHelpers from "../utils/helpers.js"
const { streamMessage, parseSSEFrames } = createHelpers({ POST, axios })

describe("@cap-js/agents - local sub-agent delegation (hybrid)", () => {
  it("CatalogService delegates to the GraphBookService sub-agent without a null-state error", async () => {
    const res = await streamMessage(
      "catalog",
      "Use the graphbookservice sub-agent to list books, then tell me what it returned.",
    )
    const frames = parseSSEFrames(res.data)

    // The sub-agent's null-state crash surfaced as this exact tool/agent error.
    const nullStateError = frames.find((f) => JSON.stringify(f).includes("reading 'messages'"))
    expect(nullStateError, "sub-agent must not fail with a null-state error").toBeFalsy()

    const final = frames.find((f) => ["completed", "failed"].includes(f.result?.status?.state))
    expect(final?.result?.status?.state, "task should complete, not fail").toBe("completed")

    // The parent's answer should reflect real book data the sub-agent queried.
    const text = final?.result?.status?.message?.parts
      ?.filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("")
    expect(text).toMatch(/book/i)
  }, 120000)
})
