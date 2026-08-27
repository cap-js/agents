import assert from "node:assert/strict"

import path from "node:path"
import cds from "@sap/cds"

// Boot from the node-bookshop sidecar fixture with agent-sidecar,node profile.
// The model is loaded from the node-bookshop sample's srv directory.
const { axios } = cds.test(path.resolve(import.meta.dirname, "data/node-bookshop-sidecar"))

describe("Node Bookshop Sidecar - HTTP Wiring", () => {
  it("bootstrapSidecar mounts the A2A agent card endpoint for a Node main app", async () => {
    const { bootstrapSidecar } = await import("../../lib/sidecar.js")

    // bootstrapSidecar scans cds.model for @agent services (CatalogService from
    // the node-bookshop fixture model), connects via slug 'catalog' (node profile),
    // and mounts the A2A router on cds.app.
    await bootstrapSidecar()

    const res = await axios.get("/a2a/catalog/.well-known/agent-card.json")
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.data.name, "CatalogService")
    assert.ok(Array.isArray(res.data.skills), "agent card should have skills")

    const skillIds = res.data.skills.map((s) => s.id)
    assert.ok(skillIds.includes("query"), "should have query skill")
    assert.ok(skillIds.includes("submitOrder"), "should have submitOrder skill")
    assert.ok(skillIds.includes("getStock"), "should have getStock skill")
  })
})
