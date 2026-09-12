import cds from "@sap/cds"
import {
  getSpansAfterRequest,
  findSpan,
  setup,
  teardown,
  resetCapture,
  createSendMessage,
} from "../utils/telemetry-utils.js"

process.env.CDS_TEST_SILENT = "false"
setup()

const SUCCESS_CASES = [
  {
    model: "gpt-5.5",
    user: "prompt-cache-55",
  },
  {
    model: "gpt-5.6-sol",
    user: "prompt-cache-56-sol",
  },
  {
    model: "gpt-5.6-terra",
    user: "prompt-cache-56-terra",
  },
  {
    model: "gpt-5.6-luna",
    user: "prompt-cache-56-luna",
  },
  {
    model: "gpt-5.4",
    user: "prompt-cache-54",
  },
  {
    model: "gpt-5.4-nano",
    user: "prompt-cache-54-nano",
  },
]

const GPT_52_CASE = {
  model: "gpt-5.2",
  user: "prompt-cache-52",
}

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
const sendMessage = createSendMessage(POST)

describe("@cap-js/agents - Hybrid prompt caching (AI Core GPT)", () => {
  axios.defaults.validateStatus = () => true
  let savedModel

  after(teardown)

  before(async () => {
    savedModel = cds.env.requires.llm.model
    await new Promise((resolve) => setTimeout(resolve, 5000))
  })

  after(() => {
    cds.env.requires.llm.model = savedModel
  })

  beforeEach(() => {
    resetCapture()
  })

  for (const { model: modelName, user } of SUCCESS_CASES) {
    it(`uses prompt caching through the agent graph for ${modelName}`, async () => {
      cds.env.requires.llm.model = modelName

      const spans = await getSpansAfterRequest(async () => {
        const res = await sendMessage("catalog", `Reply with exactly: ok (${modelName})`, {
          auth: { username: user, password: "" },
        })
        expect(res.status).toBe(200)
        expect(res.data.result?.status?.state).toBe("completed")
      })

      const chatSpan = findSpan(spans, `chat ${modelName}`)
      expect(chatSpan).toBeTruthy()
      expect(chatSpan.attributes["gen_ai.request.model"]).toBe(modelName)
      expect(chatSpan.attributes["gen_ai.request.cache_control"]).toBe(true)
      expect(chatSpan.attributes["gen_ai.response.finish_reasons"]?.length).toBeGreaterThan(0)
    }, 180000)
  }

  it("uses prompt caching for gpt-5.2 and returns expected temporary-unavailable error", async () => {
    const { model: modelName, user } = GPT_52_CASE
    cds.env.requires.llm.model = modelName

    let response
    const spans = await getSpansAfterRequest(async () => {
      response = await sendMessage("catalog", `Reply with exactly: ok (${modelName})`, {
        auth: { username: user, password: "" },
      })
    })

    expect(response.status).toBe(200)
    expect(response.data.result?.status?.state).toBe("failed")
    expect(response.data.result?.status?.message?.parts?.[0]?.text).toBe(
      "Agent error: The agent is temporarily unavailable. Please try again later.",
    )

    const chatSpan = findSpan(spans, `chat ${modelName}`)
    expect(chatSpan).toBeTruthy()
    expect(chatSpan.attributes["gen_ai.request.model"]).toBe(modelName)
    expect(chatSpan.attributes["gen_ai.request.cache_control"]).toBe(true)
  }, 180000)
})
