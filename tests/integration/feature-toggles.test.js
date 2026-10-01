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

  it("alice gets feature-toggled agent card (@agent.card override)", async () => {
    const res = await GET("/a2a/mtx-test/.well-known/agent-card.json", { auth: ALICE })
    expect(res.status).toBe(200)
    // Alice has 'experimental' feature → @agent.card annotation overridden via fts/experimental/
    expect(res.data.name).toBe("Experimental Agent")
    expect(res.data.description).toBe("Feature-toggled experimental agent")
    expect(res.data.skills.length).toBe(1)
    expect(res.data.skills[0].id).toBe("experimental-skill")
    expect(res.data.skills[0].tags).toEqual(["experimental"])
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
})
