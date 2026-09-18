import path from "node:path"
import { execSync } from "node:child_process"
import { rmSync } from "node:fs"
import cds from "@sap/cds"
import { serviceSourceDir } from "../../lib/utils/markdown.js"

const DEEP_AGENT_DIR = path.join(import.meta.dirname, "../projects/deep-agent")
const GEN_SRV_DIR = path.join(DEEP_AGENT_DIR, "gen", "srv")

// Build synchronously at module load so cds.test() below can find gen/srv.
// Runs before vitest collects the suite; cleaned up in afterAll.
rmSync(path.join(DEEP_AGENT_DIR, "gen"), { recursive: true, force: true })
execSync("cds build --production", { cwd: DEEP_AGENT_DIR, timeout: 60_000 })

afterAll(() => {
  rmSync(path.join(DEEP_AGENT_DIR, "gen"), { recursive: true, force: true })
})

const { GET } = cds.test(GEN_SRV_DIR)

// Capture all console output so we can assert that no "falling back" warn is emitted.
// serviceSourceDir must resolve via @source (not $location.file, which is absent after
// cds build) so that resolveAgentDir finds the copied agent directories under gen/srv/srv/.
const log = cds.test.log()

describe("@cap-js/agents - agent card from cds build output (gen/ folder)", () => {
  afterEach(() => {
    log.output = ""
  })

  // ── Unit: serviceSourceDir must use @source, not $location ──────────────
  //
  // After `cds build`, CDS sets $location.file = "srv/csn.json" on every service
  // definition (pointing to the compiled JSON, not the original .cds file).
  // For a service whose .cds lives in a subdirectory (e.g. srv/colocated-agent/service.cds),
  // dirname("srv/csn.json") = "srv" — wrong.
  // dirname(@source = "srv/colocated-agent/service.cds") = "srv/colocated-agent" — correct.
  // serviceSourceDir must prefer @source so resolveAgentDir finds the agent dir correctly.
  it("serviceSourceDir: prefers @source over $location after cds build", () => {
    // Simulate a built definition: @source present, $location points to csn.json
    const savedRoot = cds.root
    cds.root = GEN_SRV_DIR
    try {
      const fakeSrv = {
        definition: {
          "@source": "srv/colocated-agent/service.cds",
          // $location as set by cds.load() on csn.json — points to the JSON, not the .cds
          // If serviceSourceDir used this instead of @source it would return
          // gen/srv/srv (wrong) instead of gen/srv/srv/colocated-agent (correct).
          get $location() {
            return { file: "srv/csn.json" }
          },
        },
      }
      const dir = serviceSourceDir(fakeSrv)
      expect(dir).toBe(path.join(GEN_SRV_DIR, "srv", "colocated-agent"))
      expect(dir).not.toBe(path.join(GEN_SRV_DIR, "srv"))
    } finally {
      cds.root = savedRoot
    }
  })

  // ── Integration: agent cards resolve correctly from gen/srv ──────────────

  it("product-agent: agent card resolved from @source, skills present, no warn", async () => {
    const res = await GET("/a2a/product-agent/.well-known/agent-card.json")
    expect(res.status).toBe(200)
    const card = res.data
    expect(card.name).toBe("product-agent")
    // Skills from gen/srv/srv/product-agent/skills/ — proves agent dir was resolved
    const skill = card.skills.find((s) => s.id === "product-search")
    expect(skill, "product-search skill must be present — agent dir resolved via @source").not.toBe(
      undefined,
    )
    expect(log.output, "no fallback warn expected").not.toMatch(/falling back|not found/i)
  })

  it("zero-code-agent: agent card resolved from @source, skills present, no warn", async () => {
    const res = await GET("/a2a/zero-code-agent/.well-known/agent-card.json")
    expect(res.status).toBe(200)
    const card = res.data
    expect(card.name).toBe("zero-code-agent")
    const skill = card.skills.find((s) => s.id === "product-listing")
    expect(
      skill,
      "product-listing skill must be present — agent dir resolved via @source",
    ).not.toBe(undefined)
    expect(log.output).not.toMatch(/falling back|not found/i)
  })

  it("colocated-agent: agent card resolved from @source, co-located AGENTS.md picked up, no warn", async () => {
    const res = await GET("/a2a/colocated-agent/.well-known/agent-card.json")
    expect(res.status).toBe(200)
    const card = res.data
    expect(card.name).toBe("colocated-agent")
    const skill = card.skills.find((s) => s.id === "product-browse")
    expect(
      skill,
      "product-browse skill must be present — co-located AGENTS.md found via @source",
    ).not.toBe(undefined)
    expect(log.output).not.toMatch(/falling back|not found/i)
  })

  it("dir-override: @agent.directory resolved relative to @source dir, no warn", async () => {
    const res = await GET("/a2a/dir-override/.well-known/agent-card.json")
    expect(res.status).toBe(200)
    const card = res.data
    // card-override-agent/AGENTS.md frontmatter
    expect(card.name).toBe("card-override-agent")
    const skill = card.skills.find((s) => s.id === "product-overview")
    expect(
      skill,
      "product-overview skill must be present — @agent.directory resolved via @source",
    ).not.toBe(undefined)
    expect(log.output).not.toMatch(/falling back|not found/i)
  })

  it("override-card: @agent.card resolved relative to @source dir, no warn", async () => {
    const res = await GET("/a2a/override-card/.well-known/agent-card.json")
    expect(res.status).toBe(200)
    const card = res.data
    expect(card.name).toBe("card-override-explicit")
    const skill = card.skills.find((s) => s.id === "catalog-browse")
    expect(
      skill,
      "catalog-browse skill must be present — @agent.card resolved via @source",
    ).not.toBe(undefined)
    expect(log.output).not.toMatch(/falling back|not found/i)
  })
})
