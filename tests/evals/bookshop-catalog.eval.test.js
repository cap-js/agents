/**
 * LLM-as-judge evals for the bookshop CatalogService.
 *
 * Real agent (SAP AI Core) + real tools (no mocking) + LLM-as-judge scoring.
 * Run with:  npm run test:bookshop-evals
 *
 * Requires an AI Core binding via `cds bind` (the `test:bookshop-evals` npm
 * script uses `cds bind --exec` — same as `test:hybrid`).
 *
 * We access `test.agents.xxx` inside `beforeAll` / `it` rather than
 * destructuring at module top-level. This is deliberate: `Test.prototype.agents`
 * is patched by this plugin's cds-plugin.js when `cds.plugins.activate()`
 * runs — which happens inside the vitest `before()` hook (via `cds.exec`),
 * i.e. AFTER top-level module code but BEFORE any `beforeAll` / `it` body.
 * So `test.agents` is guaranteed available inside test scope, not before it.
 */
import cds from "@sap/cds"

const test = cds.test(import.meta.dirname + "/../samples/bookshop")

const PASS = 0.7
let judge
let runAgent, createEvalJudge, evaluate

beforeAll(async () => {
  ;({ runAgent, createEvalJudge, evaluate } = test.agents)
  judge = await createEvalJudge()
})

describe("bookshop CatalogService — LLM-as-judge evals", () => {
  it("lists books and uses the query tool on the Books entity", async () => {
    const query = "Show me all books"
    const { text, toolCalls, toolWasCalled } = await runAgent("catalog", query)

    // Two equivalent styles: bound helper vs direct array inspection.
    expect(toolWasCalled("query", { entity: "Books" })).toBe(true)
    expect(toolCalls.some((c) => c.tool === "query" && c.args?.entity === "Books")).toBe(true)

    const judgement = await evaluate(judge, {
      query,
      criteria:
        "Response must list multiple books from the catalog with recognisable titles or authors.",
      response: text,
      label: "list books",
    })
    expect(judgement.score).toBeGreaterThanOrEqual(PASS)
  })

  it("reports a specific stock level", async () => {
    const query = "How many copies of Wuthering Heights are in stock?"
    const { text, toolWasCalled } = await runAgent("catalog", query)

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
    })
    expect(judgement.score).toBeGreaterThanOrEqual(PASS)
  })

  it("answers a specific book detail question", async () => {
    const query = "Tell me about Wuthering Heights"
    const { text } = await runAgent("catalog", query)

    const judgement = await evaluate(judge, {
      query,
      criteria:
        "Response must identify Emily Brontë as the author and give at least one substantive detail about the book.",
      response: text,
      label: "book detail",
    })
    expect(judgement.score).toBeGreaterThanOrEqual(PASS)
  })
})
