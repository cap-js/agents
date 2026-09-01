import cds from "@sap/cds"
import {
  resolvePromptName,
  hashPrompt,
  linkedPromptsAttr,
  getCachedPromptVersion,
  syncPromptVersion,
} from "../../lib/telemetry/mlflow/prompts.js"

describe("resolvePromptName", () => {
  it("returns service name when service has no AGENTS.md dir", () => {
    const srv = { name: "CatalogService", definition: {} }
    expect(resolvePromptName(srv)).toBe("CatalogService")
  })

  it("returns empty string for falsy input", () => {
    expect(resolvePromptName(null)).toBe("")
    expect(resolvePromptName({})).toBe("")
  })

  it("returns a relative path ending in AGENTS.md when agent dir exists", async () => {
    const path = await import("node:path")
    const fs = await import("node:fs")
    const agentDir = path.resolve("tests/projects/deep-agent")
    if (!fs.existsSync(path.join(agentDir.default ?? agentDir, "AGENTS.md"))) return
    const stubSrv = { name: "TestDeepService", definition: { "@agent.directory": agentDir } }
    const name = resolvePromptName(stubSrv)
    expect(name).toMatch(/AGENTS\.md$/)
    expect(name).not.toMatch(/^\//)
  })
})

describe("hashPrompt", () => {
  it("returns a 16-char hex string", () => {
    expect(hashPrompt("hello")).toMatch(/^[0-9a-f]{16}$/)
  })

  it("same text produces same hash", () => {
    const t = "You are an AI assistant."
    expect(hashPrompt(t)).toBe(hashPrompt(t))
  })

  it("different text produces different hash", () => {
    expect(hashPrompt("A")).not.toBe(hashPrompt("B"))
  })
})

describe("linkedPromptsAttr + getCachedPromptVersion", () => {
  it("returns null for an unknown prompt", () => {
    expect(linkedPromptsAttr("unknown-service")).toBeNull()
    expect(getCachedPromptVersion("unknown-service")).toBeNull()
  })
})

describe("syncPromptVersion", () => {
  let _origFetch
  let _cdsEnvBefore

  beforeEach(() => {
    _origFetch = global.fetch
    _cdsEnvBefore = cds.env.agents?.mlflow
  })

  afterEach(() => {
    global.fetch = _origFetch
    if (cds.env.agents) cds.env.agents.mlflow = _cdsEnvBefore
  })

  it("returns null when mlflow is disabled", async () => {
    if (!cds.env.agents) cds.env.agents = {}
    cds.env.agents.mlflow = false
    const result = await syncPromptVersion("SomeService", "prompt text")
    expect(result).toBeNull()
  })

  it("returns null when credentials are missing", async () => {
    if (!cds.env.agents) cds.env.agents = {}
    cds.env.agents.mlflow = true
    // No mlflow credentials → resolveMlflowCredentials returns null
    const saved = cds.env.requires?.mlflow
    if (cds.env.requires) cds.env.requires.mlflow = undefined
    const result = await syncPromptVersion("SomeService", "prompt text")
    expect(result).toBeNull()
    if (cds.env.requires) cds.env.requires.mlflow = saved
  })

  it("returns cached entry without any fetch when hash matches", async () => {
    if (!cds.env.agents) cds.env.agents = {}
    cds.env.agents.mlflow = true

    const template = "You are a helpful assistant."
    const hash = hashPrompt(template)
    const promptName = "CachedService"

    let fetchCalls = 0
    global.fetch = async (url) => {
      fetchCalls++
      if (url.includes("registered-models/get")) {
        return {
          ok: true,
          json: async () => ({
            registered_model: {
              name: promptName,
              tags: [],
              // latest_versions carries version-level tags incl. hash
              latest_versions: [{ version: "3", tags: [{ key: "_cap_prompt_hash", value: hash }] }],
            },
          }),
        }
      }
      return { ok: true, json: async () => ({}) }
    }

    const savedReq = cds.env.requires
    cds.env.requires = {
      ...cds.env.requires,
      mlflow: { credentials: { MLFLOW_HOST: "http://mlflow.test" } },
    }

    const result = await syncPromptVersion(promptName, template)
    expect(result).toEqual({ name: promptName, version: "3" })
    const firstFetchCount = fetchCalls

    // Second call with same hash: cache hit → NO fetch
    fetchCalls = 0
    const result2 = await syncPromptVersion(promptName, template)
    expect(result2).toEqual({ name: promptName, version: "3" })
    expect(fetchCalls).toBe(0)

    cds.env.requires = savedReq
  })

  it("uploads a new version when hash differs from MLflow", async () => {
    if (!cds.env.agents) cds.env.agents = {}
    cds.env.agents.mlflow = true

    const promptName = "UpdatedService"
    const newTemplate = "Updated system prompt."
    const newHash = hashPrompt(newTemplate)
    const oldHash = hashPrompt("old text")

    global.fetch = async (url) => {
      if (url.includes("registered-models/get")) {
        return {
          ok: true,
          json: async () => ({
            registered_model: {
              name: promptName,
              tags: [],
              // latest_versions carries OLD hash → triggers new version upload
              latest_versions: [
                { version: "2", tags: [{ key: "_cap_prompt_hash", value: oldHash }] },
              ],
            },
          }),
        }
      }
      if (url.includes("model-versions/create")) {
        return { ok: true, json: async () => ({ model_version: { version: "3" } }) }
      }
      return { ok: true, json: async () => ({}) }
    }

    const savedReq = cds.env.requires
    cds.env.requires = {
      ...cds.env.requires,
      mlflow: { credentials: { MLFLOW_HOST: "http://mlflow.test" } },
    }

    const result = await syncPromptVersion(promptName, newTemplate)
    expect(result).toEqual({ name: promptName, version: "3" })
    expect(getCachedPromptVersion(promptName)).toEqual({ hash: newHash, version: "3" })

    cds.env.requires = savedReq
  })

  it("linkedPromptsAttr returns correct JSON after sync", () => {
    // Cache was populated by the test above
    const linked = linkedPromptsAttr("UpdatedService")
    expect(linked).not.toBeNull()
    const parsed = JSON.parse(linked)
    expect(parsed).toEqual([{ name: "UpdatedService", version: "3" }])
  })

  it("links prompt to experiment ID via _mlflow_experiment_ids tag", async () => {
    if (!cds.env.agents) cds.env.agents = {}
    cds.env.agents.mlflow = true

    const promptName = "ExperimentLinkedService"
    const template = "Link me to an experiment."
    const hash = hashPrompt(template)
    const setTagCalls = []

    global.fetch = async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {}
      if (url.includes("registered-models/get")) {
        // ensurePrompt GET — returns model with tags (no existing _mlflow_experiment_ids)
        // and latest_versions with matching hash so no new version is created
        return {
          ok: true,
          json: async () => ({
            registered_model: {
              name: promptName,
              tags: [], // no _mlflow_experiment_ids yet
              latest_versions: [{ version: "1", tags: [{ key: "_cap_prompt_hash", value: hash }] }],
            },
          }),
        }
      }
      if (url.includes("registered-models/set-tag")) {
        setTagCalls.push(body)
        return { ok: true, json: async () => ({}) }
      }
      return { ok: true, json: async () => ({}) }
    }

    const savedReq = cds.env.requires
    cds.env.requires = {
      ...cds.env.requires,
      mlflow: { credentials: { MLFLOW_HOST: "http://mlflow.test", MLFLOW_EXPERIMENT_ID: "42" } },
    }

    await syncPromptVersion(promptName, template)
    await new Promise((r) => setTimeout(r, 20))

    expect(
      setTagCalls.some((c) => c.key === "_mlflow_experiment_ids" && c.value.includes("42")),
    ).toBe(true)

    cds.env.requires = savedReq
  })
})
