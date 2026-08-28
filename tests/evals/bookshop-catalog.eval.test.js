/**
 * LLM-as-judge evals for the bookshop CatalogService.
 * Run with:  npm run test:bookshop-evals
 */
import cds from "@sap/cds"
import { vi, test } from "vitest"
import { Judge, evalRun } from "@cap-js/agents"

const PASS = 0.7

cds.test(import.meta.dirname + "/../projects/bookshop")
evalRun({ name: "bookshop-catalog-eval" })

const judge = new Judge("Response fully and accurately answers the user's question.")

describe("bookshop CatalogService — LLM-as-judge evals", () => {
  test.concurrent("lists books and uses the query tool on the Books entity", async () => {
    const query = "Show me all books"
    const agent = await cds.connect.to("CatalogService")
    const result = await agent.ask(query)

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
    const query = "How many copies of Wuthering Heights are in stock?"
    const agent = await cds.connect.to("CatalogService")
    const result = await agent.ask(query)

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
    const query = "Tell me about Wuthering Heights"
    const agent = await cds.connect.to("CatalogService")
    const result = await agent.ask(query)

    const judgement = await judge
      .criteria(
        "Response must identify Emily Brontë as the author and give at least one substantive detail about the book.",
      )
      .evaluate(result)
    expect(judgement.score).toBeGreaterThanOrEqual(PASS)
  })
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

      const result = await agent.ask(
        "Use getStock to report the stock level for Wuthering Heights.",
      )
      expect(result.text).toContain("999")
    },
  )
})
