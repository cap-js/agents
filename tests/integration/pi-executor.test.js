import cds from "@sap/cds"
import { createModels } from "@earendil-works/pi-ai"
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import createHelpers from "../utils/helpers.js"

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
const { sendMessage } = createHelpers({ POST, axios })

const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-faux" }] })
const models = createModels()
models.setProvider(faux.provider)
const [fauxModel] = faux.models

function setResponses(responses) {
  faux.setResponses(responses)
}

describe("@cap-js/agents - Pi executor integration (harness: pi)", () => {
  beforeAll(async () => {
    cds.env.agents ??= {}
    cds.env.agents.harness = 'pi'
    if (global.cds && global.cds !== cds) {
      global.cds.env.agents ??= {}
      global.cds.env.agents.harness = 'pi'
    }

    // Get the service and prepend our faux buildModel handler before the executor
    // is built. The executor cache is empty at this point (no requests yet).
    const srv = await cds.connect.to("PiAgentService")
    srv.prepend((s) =>
      s.on("buildModel", () => ({
        model: models.getModel(fauxModel.provider, fauxModel.id),
        streamFn: models.streamSimple.bind(models),
        getApiKey: () => "test-key",
      }))
    )

    setResponses([fauxAssistantMessage("warmup")])
    await sendMessage("pi-agent", "warmup")
  })

  it("completes a task and returns a completed status via the A2A endpoint", async () => {
    setResponses([fauxAssistantMessage("Books retrieved successfully")])

    const res = await sendMessage("pi-agent", "List available books")

    expect(res.status).toBe(200)
    const task = res.data.result
    expect(task).not.toBe(undefined)
    expect(typeof task.id).toBe("string")
    expect(task.status.state).toBe("completed")
  })

  it("invokes a tool call and resumes to produce the final answer", async () => {
    setResponses([
      fauxAssistantMessage(fauxToolCall("query", { cql: "SELECT * FROM Books LIMIT 3" })),
      fauxAssistantMessage("Here are the books from the catalog"),
    ])

    const res = await sendMessage("pi-agent", "What books are in the catalog?")

    expect(res.status).toBe(200)
    const task = res.data.result
    expect(task.status.state).toBe("completed")
  })

  it("maintains conversation across multiple turns with the same contextId", async () => {
    setResponses([fauxAssistantMessage("Sure, here are the books")])
    const res1 = await sendMessage("pi-agent", "Show me books")
    const contextId = res1.data.result.contextId

    setResponses([fauxAssistantMessage("Here are more details")])
    const res2 = await sendMessage("pi-agent", "Tell me more", { contextId })

    expect(res2.data.result.contextId).toBe(contextId)
    expect(res2.data.result.id).not.toBe(res1.data.result.id)
    expect(res2.data.result.status.state).toBe("completed")
  })

  it("returns a failed status when the Pi agent encounters an error", async () => {
    setResponses([fauxAssistantMessage("", { errorMessage: "Simulated Pi error" })])

    const res = await sendMessage("pi-agent", "Trigger an error")

    expect(res.status).toBe(200)
    const task = res.data.result
    expect(task.status.state).toBe("failed")
    expect(task.status.message.parts[0].text).toBeTruthy()
  })
})
