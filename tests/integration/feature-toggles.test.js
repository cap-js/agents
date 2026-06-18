import assert from "node:assert/strict"
import cds from "@sap/cds"

const { POST, GET, axios } = cds.test(import.meta.dirname + "/../samples/mtx")
axios.defaults.validateStatus = () => true

const ALICE = { username: "alice", password: "" }
const BOB = { username: "bob", password: "" }

describe("@cap-js/agents - Feature Toggles (@agent.card + @agent.directory)", () => {
  it("bob gets default agent card (no features)", async () => {
    const res = await GET("/a2a/mtx-test/.well-known/agent-card.json", { auth: BOB })
    assert.strictEqual(res.status, 200)
    // No features → base model → CDS-generated card from service definition
    assert.strictEqual(res.data.name, "MtxTestService")
  })

  it("alice gets feature-toggled agent card (@agent.card override)", async () => {
    const res = await GET("/a2a/mtx-test/.well-known/agent-card.json", { auth: ALICE })
    assert.strictEqual(res.status, 200)
    // Alice has 'experimental' feature → @agent.card annotation overridden via fts/experimental/
    assert.strictEqual(res.data.name, "Experimental Agent")
    assert.strictEqual(res.data.description, "Feature-toggled experimental agent")
    assert.strictEqual(res.data.skills.length, 1)
    assert.strictEqual(res.data.skills[0].id, "experimental-skill")
    assert.deepStrictEqual(res.data.skills[0].tags, ["experimental"])
  })

  it("different users get different cards in same process", async () => {
    // Verify caching doesn't leak between feature vectors
    const resBob = await GET("/a2a/mtx-test/.well-known/agent-card.json", { auth: BOB })
    const resAlice = await GET("/a2a/mtx-test/.well-known/agent-card.json", { auth: ALICE })
    assert.strictEqual(resBob.data.name, "MtxTestService")
    assert.strictEqual(resAlice.data.name, "Experimental Agent")
  })
})
