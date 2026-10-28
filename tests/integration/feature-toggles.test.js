import cds from "@sap/cds"

const { POST, GET, axios } = cds.test(import.meta.dirname + "/../projects/mtx")
axios.defaults.validateStatus = () => true

const ALICE = { username: "alice", password: "" }
const BOB = { username: "bob", password: "" }

describe("Feature Toggles (@agent.card + @agent.directory)", () => {
  it("bob gets default agent card (no features)", async () => {
    const res = await GET("/a2a/mtx-test/.well-known/agent-card.json", { auth: BOB })
    expect(res.status).toBe(200)
    // No features → base model → CDS-generated card from service definition
    expect(res.data.name).toBe("MtxTestService")
  })

  it("@agent.llm is feature-toggle aware", async () => {
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

    // Verify graph/model caching doesn't leak between feature vectors
    const resBob = await POST("/a2a/mtx-test/", message("bob"), { auth: BOB })
    const resAlice = await POST("/a2a/mtx-test/", message("alice"), { auth: ALICE })
    expect(resBob.data.result.status.state).toBe("completed")
    expect(resAlice.data.result.status.state).toBe("completed")
    expect(resBob.data.result.status.message.parts[0].text).toBe("llm")
    expect(resAlice.data.result.status.message.parts[0].text).toBe("another-llm")
  })

  describe("when @agent.directory is overridden by a feature toggle", () => {
    it("should resolve the feature-toggled @agent.directory when the feature is active", async () => {
      const res = await GET("/a2a/mtx-test/.well-known/agent-card.json", { auth: ALICE })
      expect(res.status).toBe(200)

      expect(res.data.name).toBe("Experimental Agent")
      expect(res.data.skills.some((s) => s.tags.includes("experimental"))).toBe(true)
    })

    it("should not replace the agent metadata when the feature is not active", async () => {
      // TODO: Review AI Test
      const res = await GET("/a2a/mtx-test/.well-known/agent-card.json", { auth: BOB })
      expect(res.status).toBe(200)

      expect(res.data.name).toBe("MtxTestService")
      expect(res.data.skills.some((s) => s.tags.includes("experimental"))).toBe(false)
    })
  })
})
