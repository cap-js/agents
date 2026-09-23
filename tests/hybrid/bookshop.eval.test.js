import cds from "@sap/cds"
import { vi, test } from "vitest"
import { Judge, matchToolCall } from "@cap-js/agents/eval"
import { setup, flushMetrics, findSpan, findSpans } from "../utils/telemetry-utils.js"
import createHelpers from "../utils/helpers.js"
import { summarizePartialWork } from "../../lib/agents/summarize-on-timeout.js"

const PASS = 0.7

setup()
const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
const { sendMessage, jsonrpc, streamMessage, parseSSEFrames, setupErrorDetection } = createHelpers({
  POST,
  axios,
})

const judge = new Judge("ANSWER_RELEVANCE_PROMPT").criteria(
  "Response fully and accurately answers the user's question.",
)

describe.concurrent("bookshop CatalogService — list books", () => {
  let result
  let spans

  before(async () => {
    const agent = await cds.connect.to("CatalogService")
    const exporter = await (await import("../utils/telemetry-utils.js")).getSpanExporter()
    exporter.reset()
    result = await agent.chat("Show me all books")
    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.forceFlush) await delegate.forceFlush().catch(() => {})
    const allSpans = exporter.getFinishedSpans()
    // Filter to spans from this request's trace only — the workflow span name is unique per service.
    spans = allSpans.filter((s) => s.spanContext().traceId === result.traceId)
  })

  // ── Functional assertions ─────────────────────────────────────────────

  it("functional correctness", async () => {
    expect(
      result.toolCalls.some((c) => c.tool === "query" && c.cqn?.SELECT?.from?.ref?.[0] === "Books"),
    ).toBe(true)
    expect(result.metrics.tool_call_count).toBeGreaterThan(0)
    expect(result.metrics.latency_ms).toBeGreaterThan(0)
    expect(matchToolCall(result, "query", (args) => !!args.cql)).toBe(true)
    const judgement = await judge
      .criteria(
        "Response must list multiple books from the catalog with recognisable titles or authors.",
      )
      .evaluate(result)
    expect(judgement.score).toBeGreaterThanOrEqual(PASS)
  })

  // ── Telemetry span assertions (same trace from the single execution) ──

  it("produces workflow span with correct name", () => {
    const wfSpan = findSpan(spans, "workflow CompiledStateGraph CatalogService")
    expect(wfSpan).not.toBe(undefined)
  })

  it("produces chat span with model name", () => {
    const chatSpan = findSpans(spans, /^chat /).at(-1)
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.operation.name"]).toBe("chat")
    expect(chatSpan.attributes["gen_ai.request.model"]).not.toBe(undefined)
  })

  it("records token usage on chat span", () => {
    const chatSpan = findSpan(spans, /^chat /)
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.usage.input_tokens"] > 0).toBeTruthy()
    expect(chatSpan.attributes["gen_ai.usage.output_tokens"] > 0).toBeTruthy()
  })

  it("sets gen_ai.response.model on chat span", () => {
    const chatSpan = findSpan(spans, /^chat /)
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.response.model"]).not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.response.model"].length > 0).toBeTruthy()
  })

  it("sets gen_ai.response.finish_reasons as array on chat span", () => {
    const chatSpan = findSpan(spans, /^chat /)
    expect(chatSpan).not.toBe(undefined)
    const finishReasons = chatSpan.attributes["gen_ai.response.finish_reasons"]
    expect(Array.isArray(finishReasons)).toBeTruthy()
    expect(finishReasons.length > 0).toBeTruthy()
    expect(
      ["stop", "end_turn", "tool_calls", "tool_use", "length", "max_tokens"].includes(
        finishReasons[0],
      ),
    ).toBeTruthy()
  })

  it("produces tool execution spans", () => {
    const toolSpans = findSpans(spans, "execute_tool")
    expect(toolSpans.length > 0).toBeTruthy()
  })

  it("has complete span hierarchy: workflow > chat in same trace", () => {
    const wfSpan = findSpan(spans, "workflow CompiledStateGraph CatalogService")
    const chatSpan = findSpan(spans, /^chat /)
    expect(wfSpan).not.toBe(undefined)
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.spanContext().traceId).toBe(wfSpan.spanContext().traceId)
  })

  it("has HTTP outbound spans for AI Core call in same trace as chat span", () => {
    const chatSpan = findSpan(spans, /^chat /)
    expect(chatSpan).not.toBe(undefined)
    const traceId = chatSpan.spanContext().traceId
    const chatSpanId = chatSpan.spanContext().spanId
    const outboundSpans = spans.filter(
      (s) =>
        s.spanContext().traceId === traceId &&
        s.spanContext().spanId !== chatSpanId &&
        (s.kind === 3 ||
          s.name.includes("POST") ||
          s.name.includes("HTTP") ||
          s.name.includes("GET")),
    )
    expect(outboundSpans.length >= 1).toBeTruthy()
  })

  it("emits agent_actions metric per LLM call", async () => {
    const output = await flushMetrics()
    expect(output).toMatch(/agent_actions/)
  })
})

describe.concurrent("bookshop CatalogService — LLM-as-judge evals", () => {
  test.concurrent("Custom prompt", async () => {
    const agent = await cds.connect.to("CatalogService")
    const result = await agent.chat("Show me all books")
    const judge = new Judge("Should behave as a helpful librarian")

    const judgement = await judge.evaluate(result)
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

describe.concurrent("bookshop CatalogService — conversation-level judges", () => {
  test.concurrent("Conversation judges over multi-turn session", async () => {
    const agent = await cds.connect.to("CatalogService")

    // Multi-turn: two questions in the same conversation context
    const r1 = await agent.chat("How many copies of Wuthering Heights are in stock?")
    const r2 = await agent.chat("Tell me about that book.", r1)

    // Conversation-level judges evaluate the full session
    const completion = await new Judge("TASK_COMPLETION_PROMPT").evaluate([r1, r2])
    expect(completion.pass, completion.comment).toBe(true)

    const retention = await new Judge("KNOWLEDGE_RETENTION_PROMPT").evaluate([r1, r2])
    expect(retention.pass, retention.comment).toBe(true)
  })

  test.concurrent("agent remembers context across turns (sendMessage)", async () => {
    const contextId = `mt-test-${Date.now()}`

    const res1 = await sendMessage("catalog", "Tell me about Wuthering Heights", { contextId })
    expect(res1.data.result.status.state).toBe("completed")
    const text1 = res1.data.result.status.message.parts[0].text
    expect(text1).toMatch(/wuthering|brontë|emily/i)
    expect(text1).not.toMatch(/technical issue|not installed|configuration issue/i)

    const res2 = await sendMessage("catalog", "Order 2 copies of that book", { contextId })
    let finalRes = res2
    if (res2.data.result.status.state === "input-required") {
      const taskId = res2.data.result.id
      finalRes = await sendMessage("catalog", "yes", { taskId })
    }

    expect(finalRes.data.result.status.state).toBe("completed")
    const text2 = finalRes.data.result.status.message.parts[0].text
    expect(text2).toMatch(/order|stock|cop/i)
    expect(text2).not.toMatch(/technical issue|not installed|configuration issue/i)
  })

  describe("bookshop CatalogService — HITL order flow", () => {
    it("rejected order can be retried after an explicit new request", async () => {
      const agent = await cds.connect.to("CatalogService")

      const requested = await agent.chat("Submit order for 1 copy of book 201 hitl")
      expect(requested.status).toBe("input-required")

      const rejected = await agent.chat("No, do not place this order.", requested)
      expect(rejected.status).toBe("completed")

      const judgement = await judge
        .criteria("Response confirms order was not placed.")
        .evaluate(rejected)
      expect(judgement.score).toBeGreaterThanOrEqual(PASS)

      const retried = await agent.chat(
        "Please place that order now. I explicitly request it.",
        rejected,
      )
      expect(retried.status).toBe("input-required")
    })

    it("submitOrder triggers HITL, approve completes order and reduces stock", async () => {
      const BOOK_ID = 9001
      const QUANTITY = 1

      await INSERT.into("sap.capire.bookshop.Books").entries({
        ID: BOOK_ID,
        title: "Test Book HITL Approve",
        author_ID: 101,
        stock: 5,
        price: 9.99,
        currency_code: "USD",
        genre_ID: 11,
      })
      try {
        const before = await SELECT.one
          .from("sap.capire.bookshop.Books")
          .columns("stock")
          .where({ ID: BOOK_ID })

        const agent = await cds.connect.to("CatalogService")
        const r1 = await agent.chat(`Submit order for ${QUANTITY} copy of book ${BOOK_ID} hitl`)
        expect(r1.status).toBe("input-required")
        expect(r1.taskId).toBeTruthy()

        const r2 = await agent.chat("yes", r1)
        expect(r2.status).toBe("completed")
        expect(r2.text).toBeTruthy()

        const after = await SELECT.one
          .from("sap.capire.bookshop.Books")
          .columns("stock")
          .where({ ID: BOOK_ID })
        expect(after.stock).toBe(before.stock - QUANTITY)

        const judgement = await judge
          .criteria("Response confirms the order was placed successfully.")
          .evaluate(r2)
        expect(judgement.score).toBeGreaterThanOrEqual(PASS)
      } finally {
        await DELETE.from("sap.capire.bookshop.Books").where({ ID: BOOK_ID })
      }
    })

    it("tasks/cancel cancels HITL task and leaves stock unchanged", async () => {
      const BOOK_ID = 9002

      await INSERT.into("sap.capire.bookshop.Books").entries({
        ID: BOOK_ID,
        title: "Test Book HITL Cancel",
        author_ID: 101,
        stock: 5,
        price: 9.99,
        currency_code: "USD",
        genre_ID: 11,
      })
      try {
        const stockBefore = await SELECT.one
          .from("sap.capire.bookshop.Books")
          .columns("stock")
          .where({ ID: BOOK_ID })

        const res = await sendMessage(
          "catalog",
          `Submit order for 2 copies of book ${BOOK_ID} hitl`,
        )
        expect(res.data.result?.status?.state).toBe("input-required")

        const cancelRes = await jsonrpc("catalog", "tasks/cancel", { id: res.data.result.id })
        expect(cancelRes.data.result.status.state).toBe("canceled")

        const stockAfter = await SELECT.one
          .from("sap.capire.bookshop.Books")
          .columns("stock")
          .where({ ID: BOOK_ID })
        expect(stockAfter?.stock).toBe(stockBefore?.stock)
      } finally {
        await DELETE.from("sap.capire.bookshop.Books").where({ ID: BOOK_ID })
      }
    })
  })

  describe("bookshop CatalogService — tool mocking via vitest", () => {
    test("mock getStock with vi.spyOn(agent, 'send') — auto-restored after test", async () => {
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
    })
  })
})

describe.concurrent("local subagent delegation", () => {
  it("CatalogService delegates to the GraphBookService subagent without a null-state error", async () => {
    const res = await streamMessage(
      "catalog",
      "Use the graphbookservice subagent to list books, then tell me what it returned.",
    )
    const frames = parseSSEFrames(res.data)

    const nullStateError = frames.find((f) => JSON.stringify(f).includes("reading 'messages'"))
    expect(nullStateError, "subagent must not fail with a null-state error").toBeFalsy()

    const final = frames.find((f) => ["completed", "failed"].includes(f.result?.status?.state))
    expect(final?.result?.status?.state, "task should complete, not fail").toBe("completed")

    const text = final?.result?.status?.message?.parts
      ?.filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("")
    expect(text).toMatch(/book/i)
  }, 120000)
})

describe.concurrent("timeout summary", () => {
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

  test.concurrent("asks only whether to continue or stop", async () => {
    const agent = await cds.connect.to("CatalogService")
    const summary = await summarizePartialWork({
      contextId: "timeout-summary-eval",
      serviceName: "CatalogService",
      reason: "timeOut",
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

describe.concurrent("HITL DataPart carry", () => {
  function sendParts(service, parts, { contextId, taskId } = {}) {
    return POST(`/a2a/${service}/`, {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: cds.utils.uuid(),
          role: "user",
          ...(contextId && { contextId }),
          ...(taskId && { taskId }),
          parts,
        },
      },
    })
  }

  const ORDER_TEXT =
    "Please submit an order for 1 copy of book with ID 201. Go ahead and call submitOrder directly."

  it("input-required carries a DataPart alongside the TextPart", async () => {
    const res = await sendParts("catalog", [{ kind: "text", text: ORDER_TEXT }])
    expect(res.status).toBe(200)
    expect(res.data.result?.status.state).toBe("input-required")
    const parts = res.data.result.status.message?.parts || []
    expect(parts.find((p) => p.kind === "text" || p.text)).toBeTruthy()
    const dataPart = parts.find((p) => p.kind === "data" && p.data !== undefined)
    expect(dataPart, "input-required message must carry a DataPart").toBeTruthy()
    expect(dataPart.data).toHaveProperty("actionRequests")
    expect(Array.isArray(dataPart.data.actionRequests)).toBe(true)
  })

  it("DataPart approve resume completes the task", async () => {
    const contextId = cds.utils.uuid()
    const trigger = await sendParts("catalog", [{ kind: "text", text: ORDER_TEXT }], { contextId })
    expect(trigger.data.result?.status.state).toBe("input-required")
    const taskId = trigger.data.result.id

    const resume = await sendParts(
      "catalog",
      [{ kind: "data", data: { decisions: [{ type: "approve" }] } }],
      { contextId, taskId },
    )
    expect(resume.data.result?.status.state).toBe("completed")
  })

  it("DataPart reject completes the task (action skipped, not an error)", async () => {
    const contextId = cds.utils.uuid()
    const trigger = await sendParts("catalog", [{ kind: "text", text: ORDER_TEXT }], { contextId })
    expect(trigger.data.result?.status.state).toBe("input-required")
    const taskId = trigger.data.result.id

    const resume = await sendParts(
      "catalog",
      [{ kind: "data", data: { decisions: [{ type: "reject", message: "Not now" }] } }],
      { contextId, taskId },
    )
    expect(resume.data.result?.status.state).toBe("completed")
  })

  it("edit decision injects awareness note so the agent doesn't apologize", async () => {
    const contextId = cds.utils.uuid()
    const trigger = await sendParts(
      "catalog",
      [
        {
          kind: "text",
          text: "Please submit an order for 3 copies of book with ID 201. Go ahead and call submitOrder directly.",
        },
      ],
      { contextId },
    )
    expect(trigger.data.result?.status.state).toBe("input-required")
    const taskId = trigger.data.result.id

    const dataPart = (trigger.data.result.status.message?.parts || []).find(
      (p) => p.kind === "data" && p.data !== undefined,
    )
    expect(dataPart, "expected the interrupt to carry a DataPart").toBeTruthy()
    const original = dataPart.data.actionRequests?.[0]
    expect(original, "expected at least one actionRequest").toBeTruthy()
    expect(original.name).toBe("submitOrder")

    const resume = await sendParts(
      "catalog",
      [
        {
          kind: "data",
          data: {
            decisions: [
              {
                type: "edit",
                editedAction: { name: "submitOrder", args: { ...original.args, quantity: 4 } },
              },
            ],
          },
        },
      ],
      { contextId, taskId },
    )
    expect(resume.data.result?.status.state).toBe("completed")
    const finalText = (resume.data.result.status.message?.parts ?? [])
      .filter((p) => p.kind === "text" || p.text)
      .map((p) => p.text)
      .join(" ")
    expect(finalText).toMatch(/\b4\b/)
    expect(finalText).not.toMatch(/sorry|apolog|mistake|error on my/i)
  })
})

describe("Token streaming", () => {
  setupErrorDetection()

  let origStreaming

  beforeEach(() => {
    origStreaming = cds.env.agents?.streaming
  })

  afterEach(() => {
    if (cds.env.agents) cds.env.agents.streaming = origStreaming
  })

  it("emits multiple incremental artifact-update frames (streaming:true)", async () => {
    const res = await streamMessage("catalog", "Show me all books")
    const frames = parseSSEFrames(res.data)
    const artifactFrames = frames.filter((f) => f.result?.kind === "artifact-update")

    expect(
      artifactFrames.length,
      "expected more than one artifact-update frame (real token streaming)",
    ).toBeGreaterThan(1)

    const firstArtifact = artifactFrames[0]
    expect(firstArtifact.result.artifact.artifactId).toBe("thinking-0")
    expect(firstArtifact.result.artifact.parts[0].kind).toBe("text")
    expect(firstArtifact.result.artifact.parts[0].text.length).toBeGreaterThan(0)
    expect(firstArtifact.result.append ?? false).toBe(false)

    const incrementalFrames = artifactFrames.filter(
      (f) => f.result?.append === true && f.result?.lastChunk !== true,
    )
    expect(
      incrementalFrames.length,
      "expected at least one incremental append frame",
    ).toBeGreaterThan(0)

    const lastArtifact = artifactFrames[artifactFrames.length - 1]
    expect(lastArtifact.result.lastChunk).toBe(true)
    expect(lastArtifact.result.append).toBe(false)

    const completed = frames.find(
      (f) => f.result?.kind === "status-update" && f.result?.final === true,
    )
    expect(completed?.result?.status?.state).toBe("completed")
  }, 180000)

  it("falls back to single artifact frame when streaming:false", async () => {
    cds.env.agents ??= {}
    cds.env.agents.streaming = false

    const res = await streamMessage("catalog", "Show me all books")
    const frames = parseSSEFrames(res.data)
    const artifactFrames = frames.filter((f) => f.result?.kind === "artifact-update")
    const incrementalFrames = artifactFrames.filter(
      (f) => f.result?.append === true && f.result?.lastChunk !== true,
    )
    expect(
      incrementalFrames.length,
      "expected no incremental token frames when streaming:false",
    ).toBe(0)

    const completed = frames.find(
      (f) => f.result?.kind === "status-update" && f.result?.final === true,
    )
    expect(completed?.result?.status?.state).toBe("completed")
    expect(completed?.result?.status?.message?.parts?.[0]?.text?.length).toBeGreaterThan(0)
  }, 180000)
})
