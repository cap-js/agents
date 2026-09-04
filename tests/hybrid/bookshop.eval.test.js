/**
 * LLM-as-judge evals for the bookshop CatalogService.
 * Run with:  npm run test:bookshop-evals
 */
import cds from "@sap/cds"
import { vi, test } from "vitest"
import { Judge, matchToolCall } from "@cap-js/agents/eval"

const PASS = 0.7

cds.test(import.meta.dirname + "/../projects/bookshop")

const judge = new Judge("ANSWER_RELEVANCE_PROMPT").criteria(
  "Response fully and accurately answers the user's question.",
)

describe("bookshop CatalogService — LLM-as-judge evals", () => {
  test.concurrent("lists books and uses the query tool on the Books entity", async () => {
    const agent = await cds.connect.to("CatalogService")
    const result = await agent.chat("Show me all books")

    // metrics attached ootb on result.metrics
    expect(result.metrics.tool_call_count).toBeGreaterThan(0)
    expect(result.metrics.latency_ms).toBeGreaterThan(0)

    expect(
      result.toolCalls.some((c) => c.tool === "query" && c.cqn?.SELECT?.from?.ref?.[0] === "Books"),
    ).toBe(true)

    const judgement = await judge
      .criteria(
        "Response must list multiple books from the catalog with recognisable titles or authors.",
      )
      .evaluate(result)
    expect(judgement.score).toBeGreaterThanOrEqual(PASS)
  })

  test.concurrent("reports a specific stock level", async () => {
    const agent = await cds.connect.to("CatalogService")
    const result = await agent.chat("How many copies of Wuthering Heights are in stock?")

    const tc = result.toolCalls
    expect(
      tc.some((c) => c.tool === "getStock") ||
        tc.some((c) => c.tool === "query" && JSON.stringify(c.args).includes("stock")),
    ).toBe(true)

    const judgement = await judge
      .criteria("Response must state a concrete numeric stock level for Wuthering Heights.")
      .evaluate(result)
    expect(judgement.score).toBeGreaterThanOrEqual(PASS)
  })

  test.concurrent("answers a specific book detail question", async () => {
    const agent = await cds.connect.to("CatalogService")
    const result = await agent.chat("Tell me about Wuthering Heights")

    const judgement = await judge
      .criteria(
        "Response must identify Emily Brontë as the author and give at least one substantive detail.",
      )
      .evaluate(result)
    expect(judgement.score).toBeGreaterThanOrEqual(PASS)

    const toxicity = await new Judge({ criteria: "TOXICITY_PROMPT", continuous: false }).evaluate(
      result,
    )
    expect(toxicity.score).toBe(false)
  })

  test.concurrent("base judge still works with .criteria() chaining", async () => {
    const agent = await cds.connect.to("CatalogService")
    const result = await agent.chat("Show me all books")

    const judgement = await judge
      .criteria("Response must list multiple books from the catalog.")
      .evaluate(result)
    expect(judgement.score).toBeGreaterThanOrEqual(PASS)
  })

  describe("bookshop CatalogService — tool mocking via vitest", () => {
    test.concurrent(
      "mock getStock with vi.spyOn(agent, 'send') — auto-restored after test",
      async () => {
        const agent = await cds.connect.to("CatalogService")
        const original = agent.send.bind(agent)

        vi.spyOn(agent, "send").mockImplementation((event, ...args) => {
          if (event === "getStock" || event?.event === "getStock") return 999
          return original(event, ...args)
        })

        const result = await agent.chat(
          "Use getStock to report the stock level for Wuthering Heights.",
        )
        expect(result.text).toContain("999")
      },
    )
  })

  describe("bookshop CatalogService — trajectory & tool call validation", () => {
    test.concurrent("matchToolCall + success_rate rollup", async () => {
      const agent = await cds.connect.to("CatalogService")
      const result = await agent.chat("Show me all books")

      // Deterministic tool call assertion — contributes to success_rate rollup
      expect(matchToolCall(result, "query", (args) => !!args.cql)).toBe(true)

      // LLM judge — also contributes to rollup
      const judgement = await judge.criteria("Response must list multiple books.").evaluate(result)
      expect(judgement.pass).toBe(true)

      // result.metrics populated ootb; validations flushed in afterEach via evalRun
      expect(result.metrics.latency_ms).toBeGreaterThan(0)
    })

    test.concurrent("Judge trajectory mode — LLM scores tool usage trajectory", async () => {
      const agent = await cds.connect.to("CatalogService")
      const result = await agent.chat("How many copies of Wuthering Heights are in stock?")

      const trajectoryJudge = new Judge({
        criteria: "TRAJECTORY_ACCURACY_PROMPT",
        type: "trajectory",
      }).criteria("Agent must retrieve stock information using a tool before answering.")
      const { pass } = await trajectoryJudge.evaluate(result)
      expect(pass).toBe(true)
    })
  })
})

describe("bookshop CatalogService — conversation-level judges", () => {
  test.concurrent("Conversation judges over multi-turn session", async () => {
    const agent = await cds.connect.to("CatalogService")

    // Multi-turn: two questions in the same conversation context
    const r1 = await agent.chat("How many copies of Wuthering Heights are in stock?")
    const r2 = await agent.chat("Tell me about that book.", r1)

    // Conversation-level judges evaluate the full session
    const completion = await new Judge("TASK_COMPLETION_PROMPT").evaluate([r1, r2])
    expect(completion.pass).toBe(true)

    const retention = await new Judge("KNOWLEDGE_RETENTION_PROMPT").evaluate([r1, r2])
    expect(retention.pass).toBe(true)
  })

  describe("bookshop CatalogService — HITL order flow", () => {
    test.concurrent(
      "submitOrder triggers HITL, approve completes order and reduces stock",
      async () => {
        const BOOK_ID = 201
        const QUANTITY = 1

        // Read stock before order
        const before = await SELECT.one
          .from("sap.capire.bookshop.Books")
          .columns("stock")
          .where({ ID: BOOK_ID })
        expect(before?.stock).toBeGreaterThanOrEqual(QUANTITY)

        const agent = await cds.connect.to("CatalogService")

        // Step 1: chat agent to order — submitOrder is @agent.hitl so agent pauses for approval
        const r1 = await agent.chat(`Submit order for ${QUANTITY} copy of book ${BOOK_ID} hitl`)
        expect(r1.status).toBe("input-required")
        expect(r1.taskId).toBeTruthy()

        // Step 2: approve — pass r1 directly so taskId + contextId are forwarded
        const r2 = await agent.chat("yes", r1)
        expect(r2.status).toBe("completed")
        expect(r2.text).toBeTruthy()

        // Stock reduced
        const after = await SELECT.one
          .from("sap.capire.bookshop.Books")
          .columns("stock")
          .where({ ID: BOOK_ID })
        expect(after.stock).toBe(before.stock - QUANTITY)

        // LLM judge confirms the response acknowledges the completed order
        const judgement = await judge
          .criteria("Response confirms the order was placed successfully.")
          .evaluate(r2)
        expect(judgement.score).toBeGreaterThanOrEqual(PASS)
      },
    )
  })
})
