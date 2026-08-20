import cds from "@sap/cds"

const {
  GraphExecutor,
  messageText,
  defaultOutputMapper,
  agentMessage,
  parseResumeDecision,
  extractInterruptData,
  composeEditNote,
} = await import("../../srv/handlers/graph-executor.js")
const { firstDataPart } = await import("../../lib/utils/message-handling.js")
const { createEmitDataPartTool } = await import("../../srv/handlers/tools.js")

const fakeEventBus = { publish: () => {}, finished: () => {} }

// Wrap a test body so it runs inside a fresh CDS context (needed by graph-executor
// paths that read cds.context / call audit()).
const withCtx = (fn) => () => cds._with({}, fn)

describe("messageText", () => {
  it("returns string content unchanged", () => {
    expect(messageText("hello")).toBe("hello")
  })

  it("joins text blocks from a content-block array, dropping non-text blocks", () => {
    const content = [
      { index: 0, type: "text", text: "Here are the books:" },
      { type: "tool_call", id: "t1", name: "f", args: {} },
      { index: 1, type: "text", text: " done." },
    ]
    expect(messageText(content)).toBe("Here are the books: done.")
  })

  it("returns empty string for null/undefined content", () => {
    expect(messageText(null)).toBe("")
    expect(messageText(undefined)).toBe("")
  })
})

describe("defaultOutputMapper", () => {
  it("extracts text from a last message with content-block array (no raw JSON leaks)", () => {
    const result = {
      messages: [{ content: [{ index: 0, type: "text", text: "The answer." }] }],
    }
    expect(defaultOutputMapper(result)).toBe("The answer.")
  })

  it("falls back to result.output when the last message has no text", () => {
    const result = {
      messages: [{ content: [{ type: "tool_call", id: "t1", name: "f", args: {} }] }],
      output: "from output field",
    }
    expect(defaultOutputMapper(result)).toBe("from output field")
  })

  it("returns { text, data } for a structuredResponse (text + DataPart)", () => {
    const result = {
      messages: [{ content: "Here is the summary." }],
      structuredResponse: { total: 3, items: ["a", "b", "c"] },
    }
    expect(defaultOutputMapper(result)).toEqual({
      text: "Here is the summary.",
      data: { total: 3, items: ["a", "b", "c"] },
    })
  })

  it("maps a plain-object result.output to a DataPart with empty text (no malformed TextPart)", () => {
    const result = { output: { status: "ok", count: 2 } }
    expect(defaultOutputMapper(result)).toEqual({ text: "", data: { status: "ok", count: 2 } })
  })
})

describe("GraphExecutor - configMapper", () => {
  it(
    "calls configMapper and spreads result into config.configurable",
    withCtx(async () => {
      let capturedConfig

      const fakeGraph = {
        checkpointer: {}, // prevent auto-injection of CdsCheckpointSaver
        invoke: async (_input, config) => {
          capturedConfig = config
          return { messages: [{ content: "ok" }] }
        },
      }

      const executor = new GraphExecutor(
        Promise.resolve(fakeGraph),
        { name: "TestService" },
        {
          configMapper: () => ({ myKey: "injected-value" }),
        },
      )

      await executor.execute(
        {
          taskId: "task-1",
          contextId: "ctx-1",
          userMessage: { parts: [{ kind: "text", text: "hello" }] },
          task: { status: { state: "working" } },
        },
        fakeEventBus,
      )

      expect(capturedConfig, "graph.invoke must have been called").toBeTruthy()
      expect(
        capturedConfig.configurable.myKey,
        "configMapper return value must appear in config.configurable",
      ).toBe("injected-value")
    }),
  )

  it(
    "reserved keys (thread_id, _taskId, _service) take precedence over configMapper",
    withCtx(async () => {
      let capturedConfig

      const fakeGraph = {
        checkpointer: {},
        invoke: async (_input, config) => {
          capturedConfig = config
          return { messages: [{ content: "ok" }] }
        },
      }

      // configMapper must not be able to overwrite reserved keys — they must always be spread last
      const executor = new GraphExecutor(
        Promise.resolve(fakeGraph),
        { name: "TestService" },
        {
          configMapper: () => ({
            thread_id: "HACKER",
            _taskId: "HACKER",
            _service: "HACKER",
            safe: "allowed",
          }),
        },
      )

      await executor.execute(
        {
          taskId: "task-2",
          contextId: "ctx-2",
          userMessage: { parts: [{ kind: "text", text: "hello" }] },
          task: { status: { state: "working" } },
        },
        fakeEventBus,
      )

      expect(capturedConfig.configurable.thread_id).not.toBe("HACKER")
      expect(capturedConfig.configurable._taskId).not.toBe("HACKER")
      expect(capturedConfig.configurable._service).not.toBe("HACKER")
      expect(capturedConfig.configurable.safe).toBe("allowed")
    }),
  )

  it(
    "works without configMapper (no regression)",
    withCtx(async () => {
      let capturedConfig

      const fakeGraph = {
        checkpointer: {},
        invoke: async (_input, config) => {
          capturedConfig = config
          return { messages: [{ content: "ok" }] }
        },
      }

      const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

      await executor.execute(
        {
          taskId: "task-3",
          contextId: "ctx-3",
          userMessage: { parts: [{ kind: "text", text: "hello" }] },
          task: { status: { state: "working" } },
        },
        fakeEventBus,
      )

      expect(capturedConfig?.configurable?.thread_id, "thread_id must be set").toBeTruthy()
      expect(capturedConfig?.configurable?._taskId, "_taskId must be set").toBeTruthy()
    }),
  )

  it(
    "async configMapper is awaited — its resolved values reach config.configurable",
    withCtx(async () => {
      let capturedConfig

      const fakeGraph = {
        checkpointer: {},
        invoke: async (_input, config) => {
          capturedConfig = config
          return { messages: [{ content: "ok" }] }
        },
      }

      const executor = new GraphExecutor(
        Promise.resolve(fakeGraph),
        { name: "TestService" },
        {
          configMapper: async () => ({ asyncKey: "async-value" }),
        },
      )

      await executor.execute(
        {
          taskId: "task-4",
          contextId: "ctx-4",
          userMessage: { parts: [{ kind: "text", text: "hello" }] },
          task: { status: { state: "working" } },
        },
        fakeEventBus,
      )

      expect(
        capturedConfig.configurable.asyncKey,
        "async configMapper value must be awaited and present in config.configurable",
      ).toBe("async-value")
    }),
  )

  it(
    "non-object return from configMapper fails the task with TypeError",
    withCtx(async () => {
      let publishedEvents = []

      const fakeGraph = {
        checkpointer: {},
        invoke: async () => ({ messages: [{ content: "ok" }] }),
      }

      const capturingEventBus = {
        publish: (e) => publishedEvents.push(e),
        finished: () => {},
      }

      const executor = new GraphExecutor(
        Promise.resolve(fakeGraph),
        { name: "TestService" },
        {
          configMapper: () => "not-an-object",
        },
      )

      await executor.execute(
        {
          taskId: "task-5",
          contextId: "ctx-5",
          userMessage: { parts: [{ kind: "text", text: "hello" }] },
          task: { status: { state: "working" } },
        },
        capturingEventBus,
      )

      const failedEvent = publishedEvents.find((e) => e.status?.state === "failed")
      expect(failedEvent, "a failed status event must have been published").toBeTruthy()
      expect(failedEvent.status.message.parts[0].text).toMatch(
        /configMapper must return a plain object/,
      )
    }),
  )
})

describe("firstDataPart", () => {
  it("returns data from a v0.3 kind-based DataPart", () => {
    expect(firstDataPart([{ kind: "data", data: { a: 1 } }])).toEqual({ a: 1 })
  })

  it("returns value from a v1.0 oneOf DataPart", () => {
    expect(firstDataPart([{ content: { $case: "data", value: { a: 1 } } }])).toEqual({ a: 1 })
  })

  it("returns undefined for text-only, empty, omitted, or nullish DataPart values", () => {
    expect(firstDataPart([{ kind: "text", text: "hi" }])).toBeUndefined()
    expect(firstDataPart([])).toBeUndefined()
    expect(firstDataPart()).toBeUndefined()
    // Nullish DataPart values must fall through to the text parser, not be treated as real values.
    expect(firstDataPart([{ kind: "data", data: null }])).toBeUndefined()
    expect(firstDataPart([{ content: { $case: "data", value: null } }])).toBeUndefined()
  })
})

describe("agentMessage", () => {
  it("appends an opaque DataPart alongside the TextPart when data is a plain object", () => {
    const msg = agentMessage("hi", { decisions: [{ type: "approve" }] })
    expect(msg.parts).toHaveLength(2)
    expect(msg.parts[0]).toMatchObject({ kind: "text", text: "hi" })
    expect(msg.parts[1]).toEqual({ kind: "data", data: { decisions: [{ type: "approve" }] } })
    // Also covers the text-only path for non-object data.
    expect(agentMessage("hi").parts).toHaveLength(1)
    expect(agentMessage("hi", "str").parts).toHaveLength(1)
  })
})

describe("extractInterruptData", () => {
  it("returns the interrupt payload opaquely when it is a plain object", () => {
    const payload = { actionRequests: [{ name: "submitOrder" }], reviewConfigs: [] }
    expect(extractInterruptData({ __interrupt__: [{ value: payload }] })).toBe(payload)
  })

  it("returns undefined for string, array, or missing interrupt values", () => {
    expect(extractInterruptData({ __interrupt__: [{ value: "approve?" }] })).toBeUndefined()
    expect(extractInterruptData({ __interrupt__: [{ value: ["a", "b"] }] })).toBeUndefined()
    expect(extractInterruptData({})).toBeUndefined()
  })
})

describe("parseResumeDecision", () => {
  it("maps approve synonyms to an approve decision", () => {
    for (const t of ["approve", "yes", "confirm", "ok", "OK", " Approve "]) {
      expect(parseResumeDecision(t)).toEqual({ decisions: [{ type: "approve" }] })
    }
  })

  it("maps 'edit' to a distinct edit decision (not reject)", () => {
    expect(parseResumeDecision("edit")).toEqual({ decisions: [{ type: "edit" }] })
    expect(parseResumeDecision("EDIT")).toEqual({ decisions: [{ type: "edit" }] })
  })

  it("maps arbitrary text to a reject decision carrying the message", () => {
    expect(parseResumeDecision("no thanks")).toEqual({
      decisions: [{ type: "reject", message: "no thanks" }],
    })
  })
})

describe("composeEditNote", () => {
  const originalCall = { id: "tc-1", name: "submitOrder", args: { book: 201, quantity: 3 } }

  it("returns undefined for non-edit or opaque resumes", () => {
    expect(composeEditNote([originalCall], { decisions: [{ type: "approve" }] })).toBeUndefined()
    expect(
      composeEditNote([originalCall], { decisions: [{ type: "reject", message: "no" }] }),
    ).toBeUndefined()
    expect(composeEditNote([originalCall], { foo: 1 })).toBeUndefined()
    expect(composeEditNote([originalCall], undefined)).toBeUndefined()
  })

  it("returns undefined for a no-op edit (edited args structurally equal to originals)", () => {
    const noopEdit = {
      decisions: [
        { type: "edit", editedAction: { name: "submitOrder", args: { quantity: 3, book: 201 } } },
      ],
    }
    expect(composeEditNote([originalCall], noopEdit)).toBeUndefined()
  })

  it("produces a firm, prescriptive note when args changed", () => {
    const edit = {
      decisions: [
        { type: "edit", editedAction: { name: "submitOrder", args: { book: 201, quantity: 4 } } },
      ],
    }
    const note = composeEditNote([originalCall], edit)
    expect(note).toBeTypeOf("string")
    expect(note).toMatch(/intentional user action/i)
    expect(note).toMatch(/do not apologize/i)
    expect(note).toContain('"quantity":3')
    expect(note).toContain('"quantity":4')
    expect(note).toContain("submitOrder")
  })

  it("matches decisions to originals by name — auto-approved tool_calls don't misalign", () => {
    // AI proposed 3 tool_calls; only submitOrder + refund are HITL. listBooks was
    // auto-approved and isn't in the resume decisions. Naive positional matching
    // would pair edit(submitOrder) with listBooks — wrong.
    const originals = [
      { id: "tc-1", name: "listBooks", args: {} },
      { id: "tc-2", name: "submitOrder", args: { book: 201, quantity: 3 } },
      { id: "tc-3", name: "refund", args: { orderId: 99 } },
    ]
    const resume = {
      decisions: [
        { type: "edit", editedAction: { name: "submitOrder", args: { book: 201, quantity: 4 } } },
        { type: "edit", editedAction: { name: "refund", args: { orderId: 100 } } },
      ],
    }
    const note = composeEditNote(originals, resume)
    expect(note).toContain("submitOrder")
    expect(note).toContain("refund")
    expect(note).not.toContain("listBooks")
    expect(note).toContain('"quantity":4')
    expect(note).toContain('"orderId":100')
  })
})

describe("GraphExecutor - HITL DataPart resume", () => {
  it(
    "passes an inbound DataPart's data opaquely into Command({ resume })",
    withCtx(async () => {
      let capturedInput
      const fakeGraph = {
        checkpointer: {},
        invoke: async (input) => {
          capturedInput = input
          return { messages: [{ content: "done" }] }
        },
      }

      const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

      await executor.execute(
        {
          taskId: "task-hitl-1",
          contextId: "ctx-hitl-1",
          userMessage: { parts: [{ kind: "data", data: { decisions: [{ type: "approve" }] } }] },
          task: { status: { state: "input-required" } },
        },
        fakeEventBus,
      )

      // `.resume` is a documented public field on Command (@langchain/langgraph).
      expect(capturedInput?.resume).toEqual({ decisions: [{ type: "approve" }] })
    }),
  )

  it(
    "fails the task when a resume has neither text nor a DataPart",
    withCtx(async () => {
      let publishedEvents = []
      const fakeGraph = {
        checkpointer: {},
        invoke: async () => ({ messages: [{ content: "done" }] }),
      }
      const capturingEventBus = {
        publish: (e) => publishedEvents.push(e),
        finished: () => {},
      }

      const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

      await executor.execute(
        {
          taskId: "task-hitl-3",
          contextId: "ctx-hitl-3",
          userMessage: { parts: [] },
          task: { status: { state: "input-required" } },
        },
        capturingEventBus,
      )

      const failedEvent = publishedEvents.find((e) => e.status?.state === "failed")
      expect(failedEvent, "a failed status event must have been published").toBeTruthy()
      expect(failedEvent.status.message.parts[0].text).toMatch(
        /must contain text .* or a data part/,
      )
    }),
  )
})

describe("GraphExecutor - HITL suspend carries a DataPart", () => {
  it(
    "attaches the structured interrupt payload as a DataPart beside the TextPart",
    withCtx(async () => {
      let publishedEvents = []

      const payload = { actionRequests: [{ name: "submitOrder", description: "Approve order?" }] }
      const fakeGraph = {
        checkpointer: {},
        invoke: async () => ({ __interrupt__: [{ value: payload }] }),
      }

      const capturingEventBus = {
        publish: (e) => publishedEvents.push(e),
        finished: () => {},
      }

      const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

      await executor.execute(
        {
          taskId: "task-suspend-1",
          contextId: "ctx-suspend-1",
          userMessage: { parts: [{ kind: "text", text: "buy the book" }] },
          task: { status: { state: "working" } },
        },
        capturingEventBus,
      )

      const inputRequired = publishedEvents.find((e) => e.status?.state === "input-required")
      expect(inputRequired, "an input-required event must have been published").toBeTruthy()
      const parts = inputRequired.status.message.parts
      expect(parts.find((p) => p.kind === "text")?.text).toBe("Approve order?")
      expect(parts.find((p) => p.kind === "data")?.data).toEqual(payload)
    }),
  )
})

describe("GraphExecutor - completion carries a DataPart", () => {
  const runToCompletion = async (options) => {
    const publishedEvents = []
    const fakeGraph = {
      checkpointer: {},
      invoke: async () => ({ messages: [{ content: "here is your data" }] }),
    }
    const capturingEventBus = { publish: (e) => publishedEvents.push(e), finished: () => {} }
    const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, options)
    await executor.execute(
      {
        taskId: "task-complete-1",
        contextId: "ctx-complete-1",
        userMessage: { parts: [{ kind: "text", text: "give me data" }] },
        task: { status: { state: "working" } },
      },
      capturingEventBus,
    )
    return publishedEvents
  }

  it(
    "emits the structured data as a DataPart on the completed message and the response artifact",
    withCtx(async () => {
      const data = { total: 3, items: ["a", "b", "c"] }
      // Custom outputMapper returning { text, data } — the normalization path.
      const events = await runToCompletion({ outputMapper: () => ({ text: "here you go", data }) })

      const completed = events.find((e) => e.status?.state === "completed")
      expect(completed, "a completed status event must have been published").toBeTruthy()
      const parts = completed.status.message.parts
      expect(parts.find((p) => p.kind === "text")?.text).toBe("here you go")
      expect(parts.find((p) => p.kind === "data")?.data).toEqual(data)

      // The authoritative "response" artifact carries the DataPart too (streaming clients).
      const responseArtifact = events.find(
        (e) => e.kind === "artifact-update" && e.artifact?.artifactId === "response",
      )
      expect(responseArtifact.artifact.parts.find((p) => p.kind === "data")?.data).toEqual(data)
    }),
  )

  it(
    "round-trips: firstDataPart reads the completed message back into the original object",
    withCtx(async () => {
      const data = { orderId: 42, status: "confirmed" }
      const events = await runToCompletion({ outputMapper: () => ({ text: "done", data }) })
      const completed = events.find((e) => e.status?.state === "completed")
      // A caller (agent A) reading agent B's completed message via the inbound utility.
      expect(firstDataPart(completed.status.message.parts)).toEqual(data)
    }),
  )

  it(
    "default text-only result yields a single TextPart, no DataPart (backward compatible)",
    withCtx(async () => {
      const events = await runToCompletion({}) // defaultOutputMapper → string
      const completed = events.find((e) => e.status?.state === "completed")
      const parts = completed.status.message.parts
      expect(parts).toHaveLength(1)
      expect(parts[0]).toMatchObject({ kind: "text", text: "here is your data" })
      expect(firstDataPart(parts)).toBeUndefined()
    }),
  )
})

describe("GraphExecutor - tool-result DataParts surface as artifact-update events", () => {
  const runWithToolContent = async (content) => {
    const publishedEvents = []
    const fakeGraph = {
      checkpointer: {},
      invoke: async () => ({
        messages: [
          { content: "final answer" },
          { content, tool_call_id: "tc-1" }, // a ToolMessage carrying embedded parts
        ],
      }),
    }
    const capturingEventBus = { publish: (e) => publishedEvents.push(e), finished: () => {} }
    const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})
    await executor.execute(
      {
        taskId: "task-scan-1",
        contextId: "ctx-scan-1",
        userMessage: { parts: [{ kind: "text", text: "go" }] },
        task: { status: { state: "working" } },
      },
      capturingEventBus,
    )
    return publishedEvents
  }

  it(
    "publishes a data-* artifact for a {kind:'data'} object embedded in tool-result content",
    withCtx(async () => {
      const data = { rows: [{ id: 1 }, { id: 2 }], meta: { source: "db" } }
      const events = await runWithToolContent(JSON.stringify({ kind: "data", data }))
      const dataArtifact = events.find(
        (e) => e.kind === "artifact-update" && e.artifact?.artifactId?.startsWith("data-"),
      )
      expect(dataArtifact, "a data-* artifact-update must have been published").toBeTruthy()
      expect(dataArtifact.artifact.parts[0]).toEqual({ kind: "data", data })
    }),
  )

  it(
    "surfaces both a file-* and a data-* artifact from mixed tool-result content",
    withCtx(async () => {
      const data = { ok: true }
      const filePart = {
        kind: "file",
        file: { name: "r.csv", mimeType: "text/csv", bytes: "YQ==" },
      }
      const content = `prefix ${JSON.stringify(filePart)} middle ${JSON.stringify({ kind: "data", data })} suffix`
      const events = await runWithToolContent(content)
      const artifactIds = events
        .filter((e) => e.kind === "artifact-update")
        .map((e) => e.artifact?.artifactId)
      expect(artifactIds).toContain("file-r.csv")
      expect(artifactIds.some((id) => id?.startsWith("data-"))).toBe(true)
    }),
  )
})

describe("emit_data_part tool", () => {
  it("returns a {kind:'data', data} JSON string the scanner can parse", async () => {
    const tool = createEmitDataPartTool()
    const raw = await tool.invoke({ data: { foo: 1, bar: ["x"] } })
    expect(JSON.parse(raw)).toEqual({ kind: "data", data: { foo: 1, bar: ["x"] } })
  })
})
