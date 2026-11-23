import cds from "@sap/cds"

const { POST, GET, axios } = cds.test(import.meta.dirname + "/../projects/mtx")
axios.defaults.validateStatus = () => true

const ALICE = { username: "alice", password: "" }
const BOB = { username: "bob", password: "" }

describe("when feature toggles override @agent annotations", () => {
  it("should provide an agent card based on default sources to a user without the feature", async () => {
    const res = await GET("/a2a/mtx-test/.well-known/agent-card.json", { auth: BOB })

    expect(res.status).toBe(200)
    expect(res.data.name).toBe("MtxTestService")
  })

  describe("when @agent.llm is overridden by a feature toggle", () => {
    const message = (text) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: cds.utils.uuid(),
          role: "user",
          parts: [{ kind: "text", text }],
        },
      },
    })

    it("should use the feature-toggled @agent.llm when the feature is active", async () => {
      const res = await POST("/a2a/mtx-test/", message("alice"), { auth: ALICE })
      expect(res.data.result.status.state).toBe("completed")
      expect(res.data.result.status.message.parts[0].text).toBe("another-llm")
    })

    it("should use the default @agent.llm when the feature is not active", async () => {
      const res = await POST("/a2a/mtx-test/", message("bob"), { auth: BOB })
      expect(res.data.result.status.state).toBe("completed")
      expect(res.data.result.status.message.parts[0].text).toBe("llm")
    })
  })

  describe("when @agent.directory is overridden by a feature toggle", () => {
    it("should resolve the feature-toggled @agent.directory when the feature is active", async () => {
      const res = await GET("/a2a/mtx-test/.well-known/agent-card.json", { auth: ALICE })
      expect(res.status).toBe(200)

      expect(res.data.name).toBe("Experimental Agent")
      expect(res.data.skills.some((s) => s.tags.includes("experimental"))).toBe(true)
    })

    it("should not replace the agent metadata when the feature is not active", async () => {
      const res = await GET("/a2a/mtx-test/.well-known/agent-card.json", { auth: BOB })
      expect(res.status).toBe(200)

      expect(res.data.name).toBe("MtxTestService")
      expect(res.data.skills.some((s) => s.tags.includes("experimental"))).toBe(false)
    })
  })
})
