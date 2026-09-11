import cds from "@sap/cds"
import { test } from "vitest"
import { Judge } from "@cap-js/agents/eval"
import { summarizePartialWork } from "../../lib/agents/summarize-on-timeout.js"

const prompt =
  "Which books are on offer? Select the most interesting one (your choice) and order it"

const messageHistory = [
  {
    _getType: () => "system",
    content:
      "You are an AI assistant for the \"CatalogService\" service. Browse and order books from the catalog Always use the provided tools to answer questions - do not make up data. Use the \u0060describe\u0060 tool to get information about the service's entities and actions if needed. Use the \u0060query\u0060 tool to read data from entities. Call action and function tools directly by name. When the user's message contains '[Uploaded files: ...]', use the \u0060read_file\u0060 tool to read each listed file before answering. Use \u0060emit_file_part\u0060 to return files in your response. Be concise and helpful.",
  },
  { _getType: () => "human", content: prompt },
  { _getType: () => "ai", content: "" },
  { _getType: () => "tool", content: 'Error executing CQL: "name" not found in "author"' },
  { _getType: () => "ai", content: "" },
  {
    _getType: () => "tool",
    content:
      'service: CatalogService description: "Browse and order books from the catalog\nBrowse and order books" entities: Books: description: Book details with author information keys[1]: ID queryLimits: default: null max: 1000 elements: createdAt: type: Timestamp description: Created On modifiedAt: type: Timestamp description: Changed On ID: type: Integer description: Element ID title: type: String description: Element title notNull: true descr: type: String description: Element descr author: type: String description: Element author notNull: true genre: type: Association (1-1) target: CatalogService.Genres description: Element genre genre_ID: type: Integer description: Element genre_ID stock: type: Integer description: Element stock pric...',
  },
]

cds.test(import.meta.dirname + "/../projects/bookshop")

describe("timeout summary", () => {
  test.concurrent("asks only whether to continue or stop", async () => {
    const agent = await cds.connect.to("CatalogService")
    const summary = await summarizePartialWork({
      contextId: "timeout-summary-eval",
      serviceName: "CatalogService",
      reason: "timed out",
      approval: true,
      checkpointer: {
        getTuple: async () => ({
          checkpoint: {
            channel_values: {
              messages: messageHistory,
            },
          },
        }),
      },
      getModel: () => agent.send("buildModel"),
    })

    const judgement = await new Judge()
      .criteria(
        "Judge this timeout summary for the user request. Pass only when it summarizes current progress, asks no question except one final continuation question, and that final question asks whether to continue or stop. Fail if it asks for any kind of further information.",
      )
      .evaluate({ query: prompt, text: summary })

    expect(judgement.pass, `${judgement.comment}\nSummary: ${summary}`).toBe(true)
  })
})
