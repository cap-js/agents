/**
 * LLM-as-judge evals for the bookshop CatalogService.
 *
 * Real agent (SAP AI Core) + real tools (unless mocked) + LLM-as-judge scoring.
 * Run with:  npm run test:bookshop-evals
 */
import cds from "@sap/cds"
import { test } from "vitest"

const PASS = 0.7
let judge

const { runAgent, createEvalJudge, evaluate, mockTools, clearMocks } =
  cds.test(import.meta.dirname + "/../projects/bookshop").agents.evalRun({ name: "bookshop-catalog-eval" })

beforeAll(async () => {
  judge = await createEvalJudge()
})

describe("bookshop CatalogService — LLM-as-judge evals", () => {
  test.concurrent("lists books and uses the query tool on the Books entity", async () => {
    const query = "Show me all books"
    const { text, toolCalls, toolWasCalled, traceId } = await runAgent("catalog", query)

    // Two equivalent styles: bound helper vs direct array inspection.
    // expect(toolWasCalled("query", { entity: "Books" })).toBe(true)
    expect(toolCalls.some((c) => c.tool === "query" && c.args?.cql.match(/Books/))).toBe(true)

    const judgement = await evaluate(judge, {
      query,
      criteria:
        "Response must list multiple books from the catalog with recognisable titles or authors.",
      response: text,
      label: "list books",
      traceId,
    })
    expect(judgement.score).toBeGreaterThanOrEqual(PASS)
  })

  test.concurrent("reports a specific stock level", async () => {
    const query = "How many copies of Wuthering Heights are in stock?"
    const { text, toolWasCalled, traceId } = await runAgent("catalog", query)

    // The agent may resolve stock via the `getStock` function tool or by
    // selecting the `stock` field via `query`. Either counts.
    expect(
      toolWasCalled("getStock") || toolWasCalled("query", (args) => args.includes("stock")),
    ).toBe(true)

    const judgement = await evaluate(judge, {
      query,
      criteria: "Response must state a concrete numeric stock level for Wuthering Heights.",
      response: text,
      label: "stock",
      traceId,
    })
    expect(judgement.score).toBeGreaterThanOrEqual(PASS)
  })

  test.concurrent("answers a specific book detail question", async () => {
    const query = "Tell me about Wuthering Heights"
    const { text, traceId } = await runAgent("catalog", query)

    const judgement = await evaluate(judge, {
      query,
      criteria:
        "Response must identify Emily Brontë as the author and give at least one substantive detail about the book.",
      response: text,
      label: "book detail",
      traceId,
    })
    expect(judgement.score).toBeGreaterThanOrEqual(PASS)
  })
})

describe("bookshop CatalogService — tool mocking", () => {
  test.concurrent("per-invocation mock: getStock is intercepted and returns 999", async () => {
    const { text, toolCalls, toolWasCalled } = await runAgent(
      "catalog",
      "Use getStock to report the stock level for Wuthering Heights.",
      { mocks: { getStock: async () => 999 } },
    )

    expect(toolWasCalled("getStock")).toBe(true)
    expect(toolCalls.find((c) => c.tool === "getStock")?.mocked).toBe(true)

    // The final response repeats the mocked value.
    expect(text).toContain("999")
  })

  test.concurrent("per-invocation mock + LLM judge: agent surfaces the mocked stock", async () => {
    const query = "Use getStock to report the stock level for Wuthering Heights."
    const { text, traceId } = await runAgent("catalog", query, {
      mocks: { getStock: async () => 999 },
    })

    const judgement = await evaluate(judge, {
      query,
      criteria: "Response must state 999 as the stock level for Wuthering Heights.",
      response: text,
      label: "mocked stock",
      traceId,
    })
    expect(judgement.score).toBeGreaterThanOrEqual(PASS)
  })

  describe("with suite-wide mocks", () => {
    beforeAll(() => {
      mockTools({ getStock: async () => 777 })
    })
    afterAll(() => {
      clearMocks()
    })

    test.concurrent("subsequent runAgent calls see the suite-wide mock without opts.mocks", async () => {
      const { text, toolWasCalled, toolCalls } = await runAgent(
        "catalog",
        "Use getStock to report the stock of Wuthering Heights.",
      )
      expect(toolWasCalled("getStock")).toBe(true)
      expect(toolCalls.find((c) => c.tool === "getStock")?.mocked).toBe(true)
      expect(text).toContain("777")
    })

    test.concurrent("per-invocation mocks override suite-wide mocks", async () => {
      const { text, toolCalls } = await runAgent(
        "catalog",
        "Use getStock to report the stock of Wuthering Heights.",
        { mocks: { getStock: async () => 42 } },
      )
      const stockCall = toolCalls.find((c) => c.tool === "getStock")
      expect(stockCall?.mocked).toBe(true)
      expect(stockCall?.result).toBe(42)
      expect(text).toContain("42")
    })
  })
})
