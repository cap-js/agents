import cds from "@sap/cds"
import { test } from "vitest"
import createHelpers from "../utils/helpers.js"

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/deep-agent")
const { sendMessage, jsonrpc, streamMessage, parseSSEFrames, setupErrorDetection } = createHelpers({
  POST,
  axios,
})

// Mock executor returns a recognisable string — used as negative signal for deep-agent routing.
const MOCK_EXECUTOR_TEXT = /\[Mock LLM\]|Here is a sample from|No data found\.|Could not query data/

describe.concurrent("product-agent", () => {
  let res

  before(async () => {
    res = await sendMessage("product-agent", "Show me products")
  })

  it("custom graph receives message and responds", () => {
    expect(res.data.result.status.state).toBe("completed")
  })

  it("response includes text content", () => {
    const text = res.data.result.status.message.parts[0].text
    expect(text).not.toBe(undefined)
    expect(text.length > 0, `expected text.length > 0`).toBeTruthy()
  })

  it("returns valid A2A task structure", () => {
    const task = res.data.result
    expect(task.id).not.toBe(undefined)
    expect(task.contextId).not.toBe(undefined)
    expect(task.status.state).toBe("completed")
    expect(task.status.message.role).toBe("agent")
    expect(task.status.message.parts.length).toBe(1)
    expect(task.status.message.parts[0].kind).toBe("text")
  })

  it("agent card is served", async () => {
    const cardRes = await axios.get("/a2a/product-agent/.well-known/agent-card.json")
    expect(cardRes.status).toBe(200)
    expect(cardRes.data.name).not.toBe(undefined)
    expect(cardRes.data.url.includes("/a2a/product-agent")).toBeTruthy()
  })

  it("tasks/get retrieves completed task", async () => {
    const taskId = res.data.result.id
    expect(taskId).not.toBe(undefined)
    const getRes = await jsonrpc("product-agent", "tasks/get", { id: taskId })
    expect(getRes.data.result.status.state).toBe("completed")
    expect(getRes.data.result.id).toBe(taskId)
  })

  it("tasks/cancel returns error for completed task", async () => {
    const taskId = res.data.result.id
    const cancelRes = await jsonrpc("product-agent", "tasks/cancel", { id: taskId })
    expect(cancelRes.data.error.code).toBe(-32002)
    expect(cancelRes.data.error.message.includes(taskId)).toBeTruthy()
  })

  it("routes through the auto-deepagent (not the mock executor)", () => {
    const text = res.data.result?.status?.message?.parts?.[0]?.text ?? ""
    expect(
      text,
      `mock executor response received — product-agent wiring failed: ${text}`,
    ).not.toMatch(MOCK_EXECUTOR_TEXT)
  })

  describe("tasks/cancel", () => {
    it("cancels task in input-required state", async () => {
      const r = await sendMessage("product-agent", "Order 5 Widget Pro")
      expect(r.data.result?.status?.state).toBe("input-required")
      const cancelRes = await jsonrpc("product-agent", "tasks/cancel", { id: r.data.result.id })
      expect(cancelRes.data.result.status.state).toBe("canceled")
    })

    it("returns error for non-existent task", async () => {
      const cancelRes = await jsonrpc("product-agent", "tasks/cancel", {
        id: "does-not-exist-task-id",
      })
      expect(cancelRes.data.error.code).toBe(-32001)
    })

    it("can cancel actively running task", async () => {
      const streamPromise = POST(
        "/a2a/product-agent/",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "message/stream",
          params: {
            message: {
              kind: "message",
              messageId: cds.utils.uuid(),
              role: "user",
              parts: [
                {
                  kind: "text",
                  text: "Give me a detailed analysis of all products including bulk pricing calculations for 100 units of each product",
                },
              ],
            },
          },
        },
        { responseType: "text" },
      )

      await new Promise((r) => setTimeout(r, 1000))

      const [task] = await SELECT.from("cap.agent.Tasks").orderBy("createdAt desc").limit(1)

      if (!task?.taskId || task.state === "completed" || task.state === "failed") {
        await streamPromise.catch(() => {})
        return
      }

      const cancelRes = await jsonrpc("product-agent", "tasks/cancel", { id: task.taskId })
      expect(
        cancelRes.data.result?.status?.state === "canceled" ||
          cancelRes.data.error?.code === -32002,
        "expected canceled state or taskNotCancelable error",
      ).toBeTruthy()

      await streamPromise.catch(() => {})
    })
  })
})

describe.concurrent("@agent.llm annotation", () => {
  it("annotation overrides cds.env.agents.llm for the annotated service", async () => {
    const srv = cds.services.LlmOverrideService
    expect(srv, "LlmOverrideService should be loaded").toBeTruthy()

    const annotated = srv.definition["@agent.llm"]
    expect(annotated).toBe("llm2")
    expect(annotated).not.toBe("llm")

    const model = await srv.send("buildModel", { srv })
    expect(model, "buildModel should return a model").toBeTruthy()
    expect(model.name).toBe(annotated)
    expect(model.options.message).toBe("[Mock LLM2] Override for testing")
  })

  it("falls back to default llm service when service has no @agent.llm annotation", async () => {
    const srv = cds.services.ProductAgentService
    expect(srv, "ProductAgentService should be loaded").toBeTruthy()

    expect(srv.definition["@agent.llm"]).toBe(undefined)

    const model = await srv.send("buildModel", { srv })
    expect(model, "buildModel should return a model").toBeTruthy()
    expect(model.name).toBe("llm")
    const resolvedName = model.orchestrationConfig?.promptTemplating?.model?.name
    expect(resolvedName).toBe(cds.requires.llm.model)
  })
})

describe.concurrent("Auto-built deep agents (zero-code convention)", () => {
  describe.concurrent("Slug-only convention (zero-code-agent)", () => {
    test.concurrent("agent card auto-generated from <slug>/AGENTS.md + skills/", async () => {
      const res = await axios.get("/a2a/zero-code-agent/.well-known/agent-card.json")
      expect(res.status).toBe(200)
      expect(res.data.name).toBe("zero-code-agent")
      expect(
        res.data.skills.find((s) => s.id === "product-listing"),
        "skills/ scan should yield product-listing",
      ).toBeTruthy()
    })

    test.concurrent(
      "message/send routes through the auto-deepagent (not the mock executor)",
      async () => {
        const res = await sendMessage("zero-code-agent", "Hi")
        const text = res.data.result?.status?.message?.parts?.[0]?.text ?? ""
        expect(
          text,
          `mock executor response received — auto-deepagent wiring failed: ${text}`,
        ).not.toMatch(MOCK_EXECUTOR_TEXT)
      },
    )
  })

  describe.concurrent("@agent.directory annotation (override-card-service)", () => {
    test.concurrent(
      "agent card resolved from annotation-pointed dir + @agent.card file",
      async () => {
        const res = await axios.get("/a2a/override-card/.well-known/agent-card.json")
        expect(res.status).toBe(200)
        expect(res.data.name).toBe("card-override-explicit")
        expect(res.data.version).toBe("2.0.0")
      },
    )

    test.concurrent(
      "message/send routes through auto-deepagent (annotation-resolved dir)",
      async () => {
        const res = await sendMessage("override-card", "Hi")
        const text = res.data.result?.status?.message?.parts?.[0]?.text ?? ""
        expect(
          text,
          `mock executor response received — @agent.directory wiring failed: ${text}`,
        ).not.toMatch(MOCK_EXECUTOR_TEXT)
      },
    )
  })

  test.concurrent("includes both auto-generated CDS tools and the user's custom tool", async () => {
    const srv = cds.services.ProductAgentService
    expect(srv, "ProductAgentService should be loaded").toBeTruthy()

    const tools = await srv.send("buildTools")
    const names = tools.map((t) => t.name)
    expect(
      names.includes("calculate_bulk_pricing"),
      `custom tool missing — got: ${names.join(", ")}`,
    ).toBeTruthy()
    expect(
      names.some((n) => /order|describe|query|Products/i.test(n)),
      `auto-generated CDS tools missing — got: ${names.join(", ")}`,
    ).toBeTruthy()
  })
})

describe.concurrent("Push Notification Delivery", () => {
  let webhookServer
  let webhookPort
  let received = []

  before(async () => {
    const { default: http } = await import("node:http")
    webhookServer = http.createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        received.push({ headers: req.headers, body: JSON.parse(body) })
        res.writeHead(200)
        res.end()
      })
    })
    await new Promise((resolve) => webhookServer.listen(0, "127.0.0.1", resolve))
    webhookPort = webhookServer.address().port
  })

  after(() => webhookServer?.close())

  beforeEach(() => {
    received = []
  })

  test.concurrent("delivers webhook POST on task state change", { timeout: 30000 }, async () => {
    const streamPromise = POST(
      "/a2a/product-agent/",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "message/stream",
        params: {
          message: {
            kind: "message",
            messageId: cds.utils.uuid(),
            role: "user",
            parts: [{ kind: "text", text: "List all products" }],
          },
          configuration: {
            pushNotificationConfig: {
              url: `http://127.0.0.1:${webhookPort}/webhook`,
            },
          },
        },
      },
      { responseType: "text" },
    )
    await streamPromise.catch(() => {})
    await new Promise((r) => setTimeout(r, 2000))

    expect(received.length > 0, `expected webhook calls, got ${received.length}`).toBeTruthy()
    expect(received[0].body.id, "webhook body should have task id").toBeTruthy()
    expect(received[0].body.status, "webhook body should have status").toBeTruthy()
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

  test("emits multiple incremental artifact-update frames (streaming:true)", async () => {
    const r = await streamMessage("product-agent", "List all products")
    const frames = parseSSEFrames(r.data)

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
  }, 120000)

  it("falls back to single artifact frame when streaming:false", async () => {
    cds.env.agents ??= {}
    cds.env.agents.streaming = false

    const r = await streamMessage("product-agent", "List all products")
    const frames = parseSSEFrames(r.data)

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
  }, 120000)
})

describe("Quota Enforcer Middleware", () => {
  let auditLogs = []

  before(async () => {
    const audit = await cds.connect.to("audit-log")
    audit.after("*", (_, req) => {
      if (typeof req.data?.data === "string") {
        req.data.data = JSON.parse(req.data.data)
      }
      auditLogs.push({ event: req.event, data: JSON.parse(JSON.stringify(req.data)) })
    })
  })

  beforeEach(() => {
    auditLogs.length = 0
  })

  it("should cancel task and emit QuotaExceeded when maxLLMInvocationsPerTask is exceeded", async () => {
    cds.env.agents ??= {}
    cds.env.agents.quotas ??= {}
    const orig = cds.env.agents.quotas.maxLLMInvocationsPerTask
    cds.env.agents.quotas.maxLLMInvocationsPerTask = 1
    try {
      const res = await sendMessage(
        "product-agent",
        "Calculate bulk pricing for 100 units of every product, then summarize the total cost",
      )
      expect(res.data.result.status.state).toBe("canceled")
      await new Promise((r) => setTimeout(r, 1000))
      const quotaEvent = auditLogs.find(
        (l) => l.event === "SecurityEvent" && l.data?.data?.event === "QuotaExceeded",
      )
      expect(quotaEvent, "Should emit QuotaExceeded audit event").toBeTruthy()
      expect(quotaEvent.data.data.reason).toMatch(/LLM call limit exceeded/)
    } finally {
      cds.env.agents.quotas.maxLLMInvocationsPerTask = orig
    }
  })

  it("should cancel task and emit QuotaExceeded when maxToolCallsPerTask is exceeded", async () => {
    cds.env.agents ??= {}
    cds.env.agents.quotas ??= {}
    const orig = cds.env.agents.quotas.maxToolCallsPerTask
    cds.env.agents.quotas.maxToolCallsPerTask = 1
    try {
      const res = await sendMessage(
        "product-agent",
        "Show me all products and calculate bulk pricing for Widget Pro at 50 units",
      )
      expect(res.data.result.status.state).toBe("canceled")
      await new Promise((r) => setTimeout(r, 1000))
      const quotaEvent = auditLogs.find(
        (l) => l.event === "SecurityEvent" && l.data?.data?.event === "QuotaExceeded",
      )
      expect(quotaEvent, "Should emit QuotaExceeded audit event").toBeTruthy()
      expect(quotaEvent.data.data.reason).toMatch(/Tool call limit exceeded/)
    } finally {
      cds.env.agents.quotas.maxToolCallsPerTask = orig
    }
  })

  it("should cancel task and emit QuotaExceeded when maxLLMTokensPerTask is exceeded", async () => {
    cds.env.agents ??= {}
    cds.env.agents.quotas ??= {}
    const orig = cds.env.agents.quotas.maxLLMTokensPerTask
    cds.env.agents.quotas.maxLLMTokensPerTask = 100
    try {
      const res = await sendMessage("product-agent", "Tell me about all your products in detail")
      expect(res.data.result.status.state).toBe("canceled")
      await new Promise((r) => setTimeout(r, 1000))
      const quotaEvent = auditLogs.find(
        (l) => l.event === "SecurityEvent" && l.data?.data?.event === "QuotaExceeded",
      )
      expect(quotaEvent, "Should emit QuotaExceeded audit event").toBeTruthy()
      expect(quotaEvent.data.data.reason).toMatch(/Token limit exceeded/)

      // Regression: follow-up message must not fail with a 400 (dangling tool call in history).
      cds.env.agents.quotas.maxLLMTokensPerTask = orig
      const contextId = res.data.result.contextId
      const followUp = await sendMessage("product-agent", "Just say hello", { contextId })
      expect(
        followUp.data.result.status.state,
        `follow-up after token-quota cancel must not fail; got: ${followUp.data.result.status.message?.parts?.[0]?.text}`,
      ).toBe("completed")
    } finally {
      cds.env.agents.quotas.maxLLMTokensPerTask = orig
    }
  })
})
