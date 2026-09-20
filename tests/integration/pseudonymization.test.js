import cds from "@sap/cds"
import { PseudoSession, PSEUDONYMIZATION_STATE_CHANNEL } from "../../lib/pseudonymize/store.js"
import * as pseudo from "../../lib/pseudonymize/helpers.js"
import { createMockAICore } from "../utils/mock-ai-core.js"
import { setup, teardown, resetCapture, getSpansAfterRequest } from "../utils/telemetry-utils.js"
import createHelpers from "../utils/helpers.js"

const mock = createMockAICore()
const mockPort = await mock.start()
process.env.MOCK_AICORE_PORT = String(mockPort)
setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
const CHECKPOINTS = "cap.agent.Checkpoints"

async function latestPseudonymizationState(threadId) {
  const row = await SELECT.one
    .from(CHECKPOINTS)
    .columns("checkpoint")
    .where({ thread_id: threadId })
    .orderBy("checkpoint_id desc")
  return JSON.parse(row?.checkpoint ?? "{}").channel_values?.[PSEUDONYMIZATION_STATE_CHANNEL]
}

describe("pseudonymization", () => {
  let sendMessage
  before(async () => {
    const helpers = createHelpers({ POST, axios })
    sendMessage = helpers.sendMessage
  })

  describe("PseudoSession", () => {
    const threadId = `CatalogService:test-context-${Date.now()}`

    afterEach(() => PseudoSession.evict(threadId))

    it("hashes a string value with property name prefix", async () => {
      const session = await PseudoSession.loadOrCreate(threadId)
      const hash = session.pseudonymize("Emily Brontë", "name")
      expect(hash).toMatch(/^name-[0-9a-f]{8}$/)
    })

    it("same value produces same hash within session (idempotent)", async () => {
      const session = await PseudoSession.loadOrCreate(threadId)
      const h1 = session.pseudonymize("Emily Brontë", "name")
      const h2 = session.pseudonymize("Emily Brontë", "name")
      expect(h1).toBe(h2)
    })

    it("different values produce different hashes", async () => {
      const session = await PseudoSession.loadOrCreate(threadId)
      const h1 = session.pseudonymize("Emily Brontë", "name")
      const h2 = session.pseudonymize("Charlotte Brontë", "name")
      expect(h1).not.toBe(h2)
    })

    it("resolveText replaces hash with original", async () => {
      const session = await PseudoSession.loadOrCreate(threadId)
      const hash = session.pseudonymize("Emily Brontë", "name")
      expect(session.resolveText(`The author is ${hash}`)).toBe("The author is Emily Brontë")
    })

    it("scrubText replaces original with hash", async () => {
      const session = await PseudoSession.loadOrCreate(threadId)
      const hash = session.pseudonymize("Emily Brontë", "name")
      expect(session.scrubText("The author is Emily Brontë")).toBe(`The author is ${hash}`)
    })

    it("remember stores externally generated pseudonyms", async () => {
      const session = await PseudoSession.loadOrCreate(threadId)
      session.remember("Emily Brontë", "person_1")
      expect(session.scrubText("The author is Emily Brontë")).toBe("The author is person_1")
      expect(session.resolveText("The author is person_1")).toBe("The author is Emily Brontë")
    })

    it("different threadIds produce different hashes for same value", async () => {
      const tid2 = `CatalogService:test-context-other-${Date.now()}`
      try {
        const s1 = await PseudoSession.loadOrCreate(threadId)
        const s2 = await PseudoSession.loadOrCreate(tid2)
        const h1 = s1.pseudonymize("Emily Brontë", "name")
        const h2 = s2.pseudonymize("Emily Brontë", "name")
        // Different seeds → different hashes with overwhelming probability
        expect(h1).not.toBe(h2)
      } finally {
        PseudoSession.evict(tid2)
      }
    })

    it("loads mappings from graph state", async () => {
      const first = await sendMessage("pseudo-book", "Who wrote these books?")
      expect(first.status).toBe(200)
      const contextId = first.data.result.contextId
      const graphThreadId = `PseudoBookService:${contextId}`
      const pseudoThreadId = `PseudoBookService:_:anonymous:${contextId}`

      const firstState = await latestPseudonymizationState(graphThreadId)
      const firstMappings = new Map(firstState?.mappings ?? [])
      const firstHash = [...firstMappings.entries()].find(
        ([, value]) => value === "Emily Brontë",
      )?.[0]
      expect(firstHash).toMatch(/^name-[0-9a-f]{8}$/)

      PseudoSession.evict(pseudoThreadId)
      const second = await sendMessage("pseudo-book", "Who wrote these books?", { contextId })
      expect(second.status).toBe(200)

      const secondState = await latestPseudonymizationState(graphThreadId)
      const secondMappings = new Map(secondState?.mappings ?? [])
      expect(secondMappings.get(firstHash)).toBe("Emily Brontë")
    })
  })

  describe("annotation resolution", () => {
    it("@PersonalData.IsPotentiallyPersonal on Authors.name is detected", async () => {
      // The bookshop Authors entity has @PersonalData.IsPotentiallyPersonal on name
      // Access via the already-loaded model from cds.test()
      const authorDef = cds.model?.definitions?.["sap.capire.bookshop.Authors"]
      if (!authorDef) return // model not loaded in this test context — skip
      expect(authorDef.elements.name["@PersonalData.IsPotentiallyPersonal"]).toBe(true)
      expect(authorDef.elements.placeOfBirth["@PersonalData.IsPotentiallyPersonal"]).toBe(true)
    })
  })

  describe("substring collision", () => {
    const threadId = `CatalogService:collision-${Date.now()}`
    afterEach(() => PseudoSession.evict(threadId))

    it("scrubText handles a value that is a substring of another", async () => {
      const session = await PseudoSession.loadOrCreate(threadId)
      const hShort = session.pseudonymize("Emily", "name")
      const hLong = session.pseudonymize("Emily Brontë", "name")
      // "Emily Brontë" must map to its own hash, not "<hashEmily> Brontë"
      expect(session.scrubText("Emily Brontë")).toBe(hLong)
      expect(session.scrubText("Emily")).toBe(hShort)
    })

    it("resolveText resolves multiple hashes regardless of order", async () => {
      const session = await PseudoSession.loadOrCreate(threadId)
      // Real hashes are fixed-shape ("prefix_8hex") and never substrings of one
      // another, so resolveText needs no ordering.
      const h1 = session.pseudonymize("Charlotte Brontë", "name")
      const h2 = session.pseudonymize("Emily Brontë", "name")
      expect(session.resolveText(`${h1} and ${h2}`)).toBe("Charlotte Brontë and Emily Brontë")
    })
  })

  describe("_shouldHash", () => {
    const { shouldHash: _shouldHash } = pseudo
    it("hashes string types", () => {
      expect(_shouldHash({ type: "cds.String" })).toBe(true)
      expect(_shouldHash({ type: "cds.UUID" })).toBe(true)
      expect(_shouldHash({ type: "cds.LargeString" })).toBe(true)
    })
    it("does not hash plain numeric/boolean/date types", () => {
      expect(_shouldHash({ type: "cds.Integer" })).toBe(false)
      expect(_shouldHash({ type: "cds.Boolean" })).toBe(false)
      expect(_shouldHash({ type: "cds.Date" })).toBe(false)
      expect(_shouldHash({ type: "cds.Timestamp" })).toBe(false)
    })
    it("hashes numeric only when key or foreign key", () => {
      expect(_shouldHash({ type: "cds.Integer", key: true })).toBe(true)
      expect(_shouldHash({ type: "cds.Integer", "@odata.foreignKey4": "author" })).toBe(true)
      expect(_shouldHash({ type: "cds.Integer" })).toBe(false)
    })
  })

  describe("_personalDataElements", () => {
    const { personalDataElements: _personalDataElements } = pseudo
    it("returns only annotated hashable elements", () => {
      const def = {
        elements: {
          name: { type: "cds.String", "@PersonalData.IsPotentiallyPersonal": true },
          plain: { type: "cds.String" },
          age: { type: "cds.Integer", "@PersonalData.IsPotentiallyPersonal": true },
        },
      }
      const set = _personalDataElements(def)
      expect(set.has("name")).toBe(true)
      expect(set.has("plain")).toBe(false) // no annotation
      expect(set.has("age")).toBe(false) // numeric, not a key
    })

    it("excludes @Common.Masked:false fields when forLlm=true", () => {
      const def = {
        elements: {
          name: {
            type: "cds.String",
            "@PersonalData.IsPotentiallyPersonal": true,
            "@Common.Masked": false,
          },
        },
      }
      expect(_personalDataElements(def, true).has("name")).toBe(false)
      expect(_personalDataElements(def, false).has("name")).toBe(true)
    })

    it("returns empty set for entity without elements", () => {
      expect(_personalDataElements(undefined).size).toBe(0)
      expect(_personalDataElements({}).size).toBe(0)
    })
  })

  describe("_pseudonymizeData", () => {
    const { pseudonymizeData: _pseudonymizeData } = pseudo
    const threadId = `CatalogService:pdata-${Date.now()}`
    afterEach(() => PseudoSession.evict(threadId))

    it("hashes annotated fields in a row array in place", async () => {
      const session = await PseudoSession.loadOrCreate(threadId)
      const rows = [
        { name: "Emily", ID: 1 },
        { name: "Charlotte", ID: 2 },
      ]
      _pseudonymizeData(rows, new Set(["name"]), session)
      expect(rows[0].name).toMatch(/^name-[0-9a-f]{8}$/)
      expect(rows[0].ID).toBe(1) // untouched
      expect(session.resolve(rows[0].name)).toBe("Emily")
    })

    it("handles a single object and null values", async () => {
      const session = await PseudoSession.loadOrCreate(threadId)
      const row = { name: "Emily", nick: null }
      _pseudonymizeData(row, new Set(["name", "nick"]), session)
      expect(row.name).toMatch(/^name-/)
      expect(row.nick).toBeNull() // null skipped
    })

    it("no-op when annotated set is empty", async () => {
      const session = await PseudoSession.loadOrCreate(threadId)
      const rows = [{ name: "Emily" }]
      _pseudonymizeData(rows, new Set(), session)
      expect(rows[0].name).toBe("Emily")
    })
  })

  describe("_resolveArgs", () => {
    const { resolveArgs: _resolveArgs } = pseudo
    const threadId = `CatalogService:rargs-${Date.now()}`
    afterEach(() => PseudoSession.evict(threadId))

    it("resolves a hash embedded inside a CQL string arg", async () => {
      const session = await PseudoSession.loadOrCreate(threadId)
      const hash = session.pseudonymize("Emily Brontë", "name")
      const args = { cql: `SELECT ID FROM Authors WHERE name = '${hash}'` }
      const resolved = _resolveArgs(args, session)
      expect(resolved.cql).toBe("SELECT ID FROM Authors WHERE name = 'Emily Brontë'")
    })

    it("resolves hashes in nested objects and arrays", async () => {
      const session = await PseudoSession.loadOrCreate(threadId)
      const hash = session.pseudonymize("Emily", "name")
      const args = { filter: { names: [hash, "plain"] }, count: 3 }
      const resolved = _resolveArgs(args, session)
      expect(resolved.filter.names[0]).toBe("Emily")
      expect(resolved.filter.names[1]).toBe("plain")
      expect(resolved.count).toBe(3) // non-string untouched
    })
  })

  describe("discoverElementsToBeMasked (alias handling)", () => {
    const { discoverElementsToBeMasked } = pseudo
    const srv = { name: "CatalogService" }
    const fields = (cql) => [...discoverElementsToBeMasked(cds.model, srv, cql, true)].sort()

    it("returns element names for plain columns", () => {
      expect(fields("SELECT ID, name, placeOfBirth FROM CatalogService.Authors")).toEqual([
        "name",
        "placeOfBirth",
      ])
    })

    it("returns the alias, not the element name, for aliased columns", () => {
      expect(fields("SELECT ID, name as authorName FROM CatalogService.Authors")).toEqual([
        "authorName",
      ])
    })

    it("returns element names for SELECT *", () => {
      expect(fields("SELECT * FROM CatalogService.Authors")).toEqual(["name", "placeOfBirth"])
    })

    it("ignores aliases on non-hashable columns", () => {
      // dateOfBirth is a Date → never hashed, even when aliased
      expect(fields("SELECT ID, dateOfBirth as dob FROM CatalogService.Authors")).toEqual([])
    })

    it("hashes a navigation path column (association.element as alias)", () => {
      // SELECT author.name as author FROM Books: ref is ["author","name"], alias "author"
      // ref[0] is an association name, not a table alias — must resolve through the association.
      // AdminService.Books keeps the author association (CatalogService.Books excludes it).
      const adminSrv = { name: "AdminService" }
      const adminFields = (cql) =>
        [...discoverElementsToBeMasked(cds.model, adminSrv, cql, true)].sort()
      expect(
        adminFields("SELECT title, author.name as author, price FROM AdminService.Books"),
      ).toEqual(["author"])
    })

    it("hashes a navigation path column without alias", () => {
      // Without alias the result key is the element name "name"
      const adminSrv = { name: "AdminService" }
      const adminFields = (cql) =>
        [...discoverElementsToBeMasked(cds.model, adminSrv, cql, true)].sort()
      expect(adminFields("SELECT title, author.name FROM AdminService.Books")).toEqual(["name"])
    })
  })

  describe("discoverElementsToBeMasked (joins)", () => {
    const { discoverElementsToBeMasked } = pseudo
    const srv = { name: "CatalogService" }
    const fields = (cql) => [...discoverElementsToBeMasked(cds.model, srv, cql, true)].sort()

    it("hashes an annotated column from a joined entity (inner join)", () => {
      expect(
        fields(
          "SELECT b.title, a.name FROM CatalogService.Books as b " +
            "INNER JOIN CatalogService.Authors as a ON b.author_ID = a.ID",
        ),
      ).toEqual(["name"])
    })

    it("uses the alias for a joined column (left join)", () => {
      expect(
        fields(
          "SELECT a.name as writer FROM CatalogService.Books as b " +
            "LEFT JOIN CatalogService.Authors as a ON b.author_ID = a.ID",
        ),
      ).toEqual(["writer"])
    })

    it("collects annotated columns across a nested 3-way join", () => {
      expect(
        fields(
          "SELECT a.name, a.placeOfBirth FROM CatalogService.Books as b " +
            "LEFT JOIN CatalogService.Authors as a ON b.author_ID = a.ID " +
            "LEFT JOIN CatalogService.Genres as g ON b.genre_code = g.code",
        ),
      ).toEqual(["name", "placeOfBirth"])
    })

    it("returns element names of all joined entities for SELECT *", () => {
      // Books projection exposes author (@PersonalData via author.name),
      // Authors contributes name + placeOfBirth
      expect(
        fields(
          "SELECT * FROM CatalogService.Books as b " +
            "JOIN CatalogService.Authors as a ON b.author_ID = a.ID",
        ),
      ).toEqual(["authorName", "name", "placeOfBirth"])
    })
  })

  // ─── E2E: full middleware hook flow ───────────────────────────────────────
  // Drives the real pseudonymizeMiddleware hooks (wrapToolCall → wrapModelCall
  // annotations, real TOON encoding, and real LangChain message classes.
  // No LLM: the model handler is a deterministic fake.
  describe("middleware E2E", () => {
    let pseudonymizeMiddleware, encode, HumanMessage, AIMessage, ToolMessage
    const srvName = "CatalogService"
    const contextId = `e2e-${Date.now()}`
    const threadId = () => pseudo.pseudonymizationThreadId(srvName, contextId)

    const runInContext = (fn) =>
      cds.context
        ? fn()
        : new Promise((resolve, reject) => {
            cds.spawn({ tenant: undefined }, async () => {
              try {
                resolve(await fn())
              } catch (e) {
                reject(e)
              }
            })
          })

    beforeAll(async () => {
      ;({ pseudonymizeMiddleware } = await import("../../lib/agents/middleware/pseudonymize.js"))
      ;({ encode } = await import("@toon-format/toon"))
      ;({ HumanMessage, AIMessage, ToolMessage } = await import("@langchain/core/messages"))
    })

    afterEach(() => PseudoSession.evict(threadId()))

    async function setupContext() {
      const srv = cds.services[srvName]
      cds.env.agents ??= {}
      cds.env.agents.masking ??= true
      const mw = pseudonymizeMiddleware(srv)
      cds.context = cds.context || {}
      cds.context.model = cds.model
      cds.context["agent.service"] = srvName
      cds.context["agent.context.id"] = contextId
      cds.context["_pseudoSession"] = undefined
      // beforeAgent establishes the session on cds.context, mirroring runtime flow
      await mw.beforeAgent()
      return { srv, mw }
    }

    it("wrapToolCall pseudonymizes annotated fields in a TOON query result", async () => {
      const { mw } = await setupContext()

      const rawContent = encode({
        data: [
          { ID: 1, name: "Emily Brontë", placeOfBirth: "Thornton" },
          { ID: 2, name: "Charlotte Brontë", placeOfBirth: "Thornton" },
        ],
      })

      const request = {
        toolCall: {
          name: "query",
          id: "tc1",
          args: { cql: "SELECT ID, name, placeOfBirth FROM CatalogService.Authors" },
        },
        tool: {},
      }
      const handler = async () =>
        new ToolMessage({ content: rawContent, tool_call_id: "tc1", name: "query" })

      const result = await mw.wrapToolCall(request, handler)
      const content = result.content

      // originals must not appear; hashes must
      expect(content).not.toContain("Emily Brontë")
      expect(content).toContain("name-")
      expect(content).toContain("placeOfBirth-")
      // ID is a key Integer → not annotated with @PersonalData → untouched
      expect(content).toContain("1")

      const emilyHash = [...cds.context._pseudoSession._hashToOriginal].find(
        ([, original]) => original === "Emily Brontë",
      )?.[0]
      expect(emilyHash).toBeDefined()
    })

    it("round-trip: hash in tool result survives model call and can resolve for user", async () => {
      const { mw } = await setupContext()

      const rawContent = encode({ data: [{ ID: 1, name: "Emily Brontë" }] })
      const toolReq = {
        toolCall: {
          name: "query",
          id: "tc1",
          args: { cql: "SELECT ID, name FROM CatalogService.Authors" },
        },
        tool: {},
      }
      const toolMsg = await mw.wrapToolCall(
        toolReq,
        async () => new ToolMessage({ content: rawContent, tool_call_id: "tc1", name: "query" }),
      )
      const hash = toolMsg.content.match(/name-[0-9a-f]{8}/)[0]

      // model may echo the hash; GraphExecutor resolves it back before publishing.
      const session = cds.context._pseudoSession
      expect(session.resolveText(`Author: ${hash}`)).toBe("Author: Emily Brontë")
    })

    it("wrapToolCall pseudonymizes annotated fields in an action/function result", async () => {
      const { mw } = await setupContext()

      // findAuthor returns a struct { name (@PersonalData), dateOfBirth }
      const rawContent = encode({
        data: { name: "Emily Brontë", dateOfBirth: "1818-07-30" },
      })
      const request = {
        toolCall: { name: "findAuthor", id: "tc1", args: { id: 1 } },
        tool: {},
      }
      const result = await mw.wrapToolCall(
        request,
        async () =>
          new ToolMessage({ content: rawContent, tool_call_id: "tc1", name: "findAuthor" }),
      )
      const content = result.content

      // annotated name → hashed; unannotated email → untouched
      expect(content).not.toContain("Emily Brontë")
      expect(content).toContain("name-")
      expect(content).toContain("1818-07-30")

      // hash resolves back to the original
      const session = cds.context["_pseudoSession"]
      const hash = content.match(/name-[0-9a-f]{8}/)[0]
      expect(session.resolve(hash)).toBe("Emily Brontë")
    })

    it("wrapToolCall hashes an aliased column using the alias as the result key", async () => {
      const { mw } = await setupContext()

      // Distinct value so it gets a fresh hash (hashing is idempotent per value
      // within a thread, and other tests already mapped "Emily Brontë").
      const author = "Aliased Author Name"
      // SELECT name as authorName → result rows carry "authorName", not "name"
      const rawContent = encode({
        data: [{ ID: 9, authorName: author }],
      })
      const request = {
        toolCall: {
          name: "query",
          id: "tc1",
          args: { cql: "SELECT ID, name as authorName FROM CatalogService.Authors" },
        },
        tool: {},
      }
      const result = await mw.wrapToolCall(
        request,
        async () => new ToolMessage({ content: rawContent, tool_call_id: "tc1", name: "query" }),
      )
      const content = result.content

      // aliased personal-data column must still be hashed (no PII leak)
      expect(content).not.toContain(author)
      // hash prefix uses the alias (the result key)
      expect(content).toMatch(/authorName-[0-9a-f]{8}/)

      const session = cds.context["_pseudoSession"]
      const hash = content.match(/authorName-[0-9a-f]{8}/)[0]
      expect(session.resolve(hash)).toBe(author)
    })

    it("wrapToolCall hashes an annotated column from a joined entity", async () => {
      const { mw } = await setupContext()

      const author = "Joined Author Value"
      // JOIN result: name comes from the joined Authors entity
      const rawContent = encode({
        data: [{ title: "Wuthering Heights", name: author }],
      })
      const request = {
        toolCall: {
          name: "query",
          id: "tc1",
          args: {
            cql:
              "SELECT b.title, a.name FROM CatalogService.Books as b " +
              "INNER JOIN CatalogService.Authors as a ON b.author_ID = a.ID",
          },
        },
        tool: {},
      }
      const result = await mw.wrapToolCall(
        request,
        async () => new ToolMessage({ content: rawContent, tool_call_id: "tc1", name: "query" }),
      )
      const content = result.content

      // annotated joined column hashed; non-personal title untouched
      expect(content).not.toContain(author)
      expect(content).toContain("Wuthering Heights")
      expect(content).toMatch(/name-[0-9a-f]{8}/)

      const session = cds.context["_pseudoSession"]
      const hash = content.match(/name-[0-9a-f]{8}/)[0]
      expect(session.resolve(hash)).toBe(author)
    })
  })
})

// ─── OTel leak check: run agent flow, verify no PII in any agent/LLM/tool span ─
describe("pseudonymization OTel leak check", () => {
  const AGENT_SPAN = /^(chat |execute_tool |workflow |task |invoke_agent)/
  axios.defaults.validateStatus = () => true
  let sendMessage
  before(async () => {
    const helpers = createHelpers({ POST, axios })
    sendMessage = helpers.sendMessage
    // Enable debug logging so gen_ai.tool.call.arguments and gen_ai.tool.call.result
    // attrs fire — these carry resolved (real) PII and must be scrubbed by the span processor.
    cds.log("agents", { level: "debug" })
    cds.env.agents.mlflow = true
  })
  after(async () => {
    cds.log("agents", { level: "warn" })
    cds.env.agents.mlflow = false
    teardown()
    await mock.stop()
  })
  beforeEach(resetCapture)

  it("does not leak personal data into any agent/LLM/tool OTel span", async () => {
    const allSpans = await getSpansAfterRequest(() =>
      sendMessage("pseudo-book", "Who wrote these books?"),
    )
    const spans = allSpans.filter((s) => AGENT_SPAN.test(s.name))
    expect(spans.length).toBeGreaterThan(0)

    // Confirm debug attrs are present — ensures the test covers the JSON-string PII path.
    // gen_ai.tool.call.arguments carries resolved (real) args going into the tool.
    const toolSpans = allSpans.filter((s) => s.name.startsWith("execute_tool"))
    const hasDebugAttr = toolSpans.some((s) => "gen_ai.tool.call.arguments" in (s.attributes ?? {}))
    expect(hasDebugAttr).toBe(true)

    const authors = (await SELECT.from("CatalogService.Authors")).map((a) => a.name)
    const offenders = []
    let sawHash = false
    for (const span of spans) {
      for (const s of collectSpanStrings(span)) {
        if (/name-[0-9a-f]{8}/.test(s)) sawHash = true
        for (const pii of authors) {
          if (s.includes(pii)) {
            offenders.push({ span: span.name, pii, snippet: s.slice(0, 160) })
          }
        }
      }
    }

    expect(offenders).toEqual([])
    expect(sawHash).toBe(true)
  })

  it("resolves pseudonymized names back to originals in the user-facing response", async () => {
    const res = await sendMessage("pseudo-book", "Who wrote these books?")
    expect(res.status).toBe(200)
    const text = res.data?.result?.status?.message?.parts?.[0]?.text ?? ""
    expect(text).toMatch(/Brontë|Poe|Carpenter/)
    expect(text).not.toMatch(/[a-z]+-[0-9a-f]{8}\b/)
  })

  it("@Common.Masked:false field is still masked in spans by default (forLlm=false in scrubToolOutputs)", async () => {
    const allSpans = await getSpansAfterRequest(() =>
      sendMessage("pseudo-book", "Who wrote these books?"),
    )
    const toolSpans = allSpans.filter((s) => s.name.startsWith("execute_tool"))
    expect(toolSpans.length).toBeGreaterThan(0)

    const placeOfDeathValues = (await SELECT.from("CatalogService.Authors"))
      .map((a) => a.placeOfDeath)
      .filter(Boolean)

    const offenders = []
    for (const span of toolSpans) {
      for (const s of collectSpanStrings(span)) {
        for (const pii of placeOfDeathValues) {
          if (s.includes(pii)) offenders.push({ span: span.name, pii, snippet: s.slice(0, 160) })
        }
      }
    }
    expect(offenders).toEqual([])

    const hasPlaceHash = toolSpans.some((s) =>
      collectSpanStrings(s).some((str) => /placeOfDeath-[0-9a-f]{8}/.test(str)),
    )
    expect(hasPlaceHash).toBe(true)
  })

  it("resolveInTraces: pseudonym tokens resolved back to originals in spans", async () => {
    cds.env.agents.masking = { ...cds.env.agents.masking, resolveInTraces: true }
    try {
      const allSpans = await getSpansAfterRequest(() =>
        sendMessage("pseudo-book", "Who wrote these books?"),
      )
      const spans = allSpans.filter((s) => AGENT_SPAN.test(s.name))
      expect(spans.length).toBeGreaterThan(0)

      // In resolveInTraces mode, spans must contain the real author names (resolved from hashes)
      const authors = (await SELECT.from("CatalogService.Authors")).map((a) => a.name)
      const resolved = []
      for (const span of spans) {
        for (const s of collectSpanStrings(span)) {
          for (const name of authors) {
            if (s.includes(name)) resolved.push(name)
          }
        }
      }
      // At least one author name must appear resolved in the spans
      expect(resolved.length).toBeGreaterThan(0)

      // No unresolved hash tokens must remain in spans
      const hasUnresolvedHash = spans.some((s) =>
        collectSpanStrings(s).some((str) => /name-[0-9a-f]{8}/.test(str)),
      )
      expect(hasUnresolvedHash).toBe(false)
    } finally {
      const { resolveInTraces: _, ...rest } = cds.env.agents.masking
      cds.env.agents.masking = rest
    }
  })

  it("resolveInTraces: @Common.Masked:false field also resolved back in spans", async () => {
    cds.env.agents.masking = { ...cds.env.agents.masking, resolveInTraces: true }
    try {
      const allSpans = await getSpansAfterRequest(() =>
        sendMessage("pseudo-book", "Who wrote these books?"),
      )
      const toolSpans = allSpans.filter((s) => s.name.startsWith("execute_tool"))
      expect(toolSpans.length).toBeGreaterThan(0)

      // placeOfDeath values must appear resolved in spans (not as hash tokens)
      const placeOfDeathValues = (await SELECT.from("CatalogService.Authors"))
        .map((a) => a.placeOfDeath)
        .filter(Boolean)
      const resolved = []
      for (const span of toolSpans) {
        for (const s of collectSpanStrings(span)) {
          for (const val of placeOfDeathValues) {
            if (s.includes(val)) resolved.push(val)
          }
        }
      }
      expect(resolved.length).toBeGreaterThan(0)

      // No placeOfDeath hash tokens must remain
      const hasUnresolvedPlaceHash = toolSpans.some((s) =>
        collectSpanStrings(s).some((str) => /placeOfDeath-[0-9a-f]{8}/.test(str)),
      )
      expect(hasUnresolvedPlaceHash).toBe(false)
    } finally {
      const { resolveInTraces: _, ...rest } = cds.env.agents.masking
      cds.env.agents.masking = rest
    }
  })
})

function collectSpanStrings(span) {
  const out = []
  const walk = (v) => {
    if (v == null) return
    if (typeof v === "string") out.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (typeof v === "object") for (const k of Object.keys(v)) walk(v[k])
  }
  walk(span.name)
  walk(span.attributes)
  walk(span.events)
  walk(span.status)
  return out
}
