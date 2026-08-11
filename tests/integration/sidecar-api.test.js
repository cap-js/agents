import assert from "node:assert/strict"

import path from "node:path"
import fs from "node:fs"
import cds from "@sap/cds"

// Boot the bookshop test app
cds.test(import.meta.dirname + "/../projects/bookshop")

describe("@cap-js/agent - Sidecar Support", () => {
  describe("createAgent programmatic API", () => {
    it("creates a router for a local ApplicationService", async () => {
      const { createA2AAgent: createAgent } = await import("../../lib/sidecar.js")
      const srv = cds.services["CatalogService"]
      const router = createAgent(srv)
      assert.notEqual(router, null)
      assert.strictEqual(typeof router, "function")
    })

    it("returns null for a service without model", async () => {
      const { createA2AAgent: createAgent } = await import("../../lib/sidecar.js")
      const fakeSrv = { name: "FakeService", definition: undefined }
      const router = createAgent(fakeSrv)
      assert.strictEqual(router, null)
    })

    it("returns null for a non-service object", async () => {
      const { createA2AAgent: createAgent } = await import("../../lib/sidecar.js")
      const router = createAgent({})
      assert.strictEqual(router, null)
    })
  })

  describe("A2AProtocolAdapter accepts cds.Service instances", () => {
    it("accepts ApplicationService (existing behavior)", async () => {
      const { default: A2AProtocolAdapter } = await import("../../lib/index.js")
      const srv = cds.services["CatalogService"]
      assert.ok(srv instanceof cds.ApplicationService)
      const router = A2AProtocolAdapter(srv)
      assert.notEqual(router, null)
    })

    it("accepts any cds.Service with a valid service definition", async () => {
      const { default: A2AProtocolAdapter } = await import("../../lib/index.js")
      const srv = cds.services["CatalogService"]
      assert.ok(srv instanceof cds.Service)
      const router = A2AProtocolAdapter(srv, { path: "/a2a/test" })
      assert.notEqual(router, null)
    })

    it("rejects service without a model", async () => {
      const { default: A2AProtocolAdapter } = await import("../../lib/index.js")
      const fakeSrv = { name: "NoModelService", definition: undefined }
      const router = A2AProtocolAdapter(fakeSrv)
      assert.strictEqual(router, null)
    })
  })

  describe("Agent card and tools work through sidecar API", () => {
    it("agent card is properly generated for service via createAgent", async () => {
      const { createA2AAgent: createAgent } = await import("../../lib/sidecar.js")
      const { generateAgentCard } = await import("../../lib/protocol/agent-card.js")
      const srv = cds.services["CatalogService"]
      const router = createAgent(srv, { path: "/a2a/catalog" })
      assert.notEqual(router, null)

      const card = generateAgentCard(srv, { path: "/a2a/catalog" })
      assert.strictEqual(card.name, "CatalogService")
      assert.ok(card.skills.length > 0)
      assert.ok(card.skills.find((s) => s.id === "query"))
      assert.ok(card.skills.find((s) => s.id === "submitOrder"))
      assert.ok(card.skills.find((s) => s.id === "getStock"))
    })

    it("tools are properly generated for service via sidecar API", async () => {
      const { generateTools } = await import("../../srv/handlers/tools.js")
      const srv = cds.services["CatalogService"]
      const tools = generateTools(srv, { skipAuth: true })
      const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]))

      assert.ok(tools.length > 0)
      assert.ok("query" in toolMap)
      assert.ok("describe" in toolMap)
      assert.ok("submitOrder" in toolMap)
      assert.ok("getStock" in toolMap)
    })
  })

  describe("Sidecar configuration profiles", () => {
    it("agent-sidecar profile sets port 4006", async () => {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(import.meta.dirname, "../../package.json"), "utf-8"),
      )
      const sidecarProfile = pkg.cds["[agent-sidecar]"]
      assert.ok(sidecarProfile, "agent-sidecar profile should exist")
      assert.strictEqual(sidecarProfile.server.port, 4006)
    })

    it("cds-plugin bootstraps sidecar on served when agent-sidecar profile is active", async () => {
      const pluginSrc = fs.readFileSync(
        path.join(import.meta.dirname, "../../cds-plugin.js"),
        "utf-8",
      )
      assert.ok(pluginSrc.includes("agent-sidecar"))
      assert.ok(pluginSrc.includes("bootstrapSidecar"))
    })
  })

  describe("bootstrapSidecar function", () => {
    it("bootstrapSidecar is a function", async () => {
      const { bootstrapSidecar } = await import("../../lib/sidecar.js")
      assert.strictEqual(typeof bootstrapSidecar, "function")
    })

    it("bootstrapSidecar handles no @agent services gracefully", async () => {
      const { bootstrapSidecar } = await import("../../lib/sidecar.js")
      await bootstrapSidecar()
    })
  })
})
