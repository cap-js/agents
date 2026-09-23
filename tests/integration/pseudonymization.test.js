import cds from "@sap/cds"
import { randomBytes } from "node:crypto"
import { PseudonymStore } from "../../lib/masking/store.js"
import { CdsCheckpointSaver } from "../../lib/protocol/persistence/checkpoint-saver.js"
import * as pseudo from "../../lib/masking/structured/index.js"
import { createMockAICore } from "../utils/mock-ai-core.js"
import { setup, teardown, resetCapture, getSpansAfterRequest } from "../utils/telemetry-utils.js"
import createHelpers from "../utils/helpers.js"
import { setupTraceScrubbing } from "../../lib/telemetry/span-masking.js"

const mock = createMockAICore()
const mockPort = await mock.start()
process.env.MOCK_AICORE_PORT = String(mockPort)
setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")

// Read the deserialized checkpoint state for a graph thread via the checkpoint saver.
async function latestMaskingState(threadId) {
  const saver = new CdsCheckpointSaver()
  const tuple = await saver.getTuple({ configurable: { thread_id: threadId } })
  const cv = tuple?.checkpoint?.channel_values ?? {}
  const raw = cv.hashToOriginal
  const hashToOriginal =
    raw instanceof Map
      ? raw
      : Array.isArray(raw)
        ? new Map(raw)
        : raw && typeof raw === "object"
          ? new Map(Object.entries(raw))
          : new Map()
  return { seed: cv.seed, hashToOriginal }
}

// Minimal in-memory session cache for unit tests (replaces the old loadOrCreate/evict).
const _sessions = new Map()
function makeSession(id) {
  if (!_sessions.has(id)) _sessions.set(id, new PseudonymStore(randomBytes(16).toString("hex")))
  return _sessions.get(id)
}
function dropSession(id) {
  _sessions.delete(id)
}

// wrapToolCall returns a Command({ update: { messages: [ToolMessage], ... } }).
const getContent = (r) => r?.update?.messages?.[0]?.content ?? r?.content

describe("pseudonymization", () => {
  let sendMessage
  before(async () => {
    const helpers = createHelpers({ POST, axios })
    sendMessage = helpers.sendMessage
    cds.env.agents.masking = true
    setupTraceScrubbing()
  })
  after(() => {
    cds.env.agents.masking = false
  })

  describe("PseudonymStore", () => {
    const id = `session-${Date.now()}`
    afterEach(() => dropSession(id))

    it("hashes a string value with property name prefix", () => {
      const session = makeSession(id)
      const hash = session.pseudonymize("Emily Brontë", "name")
      expect(hash).toMatch(/^name-[0-9a-f]{8}$/)
    })

    it("same value produces same hash within session (idempotent)", () => {
      const session = makeSession(id)
      const h1 = session.pseudonymize("Emily Brontë", "name")
      const h2 = session.pseudonymize("Emily Brontë", "name")
      expect(h1).toBe(h2)
    })

    it("different values produce different hashes", () => {
      const session = makeSession(id)
      const h1 = session.pseudonymize("Emily Brontë", "name")
      const h2 = session.pseudonymize("Charlotte Brontë", "name")
      expect(h1).not.toBe(h2)
    })

    it("resolveText replaces hash with original", () => {
      const session = makeSession(id)
      const hash = session.pseudonymize("Emily Brontë", "name")
      expect(session.resolveText(`The author is ${hash}`)).toBe("The author is Emily Brontë")
    })

    it("scrubText replaces original with hash", () => {
      const session = makeSession(id)
      const hash = session.pseudonymize("Emily Brontë", "name")
      expect(session.scrubText("The author is Emily Brontë")).toBe(`The author is ${hash}`)
    })

    it("remember stores externally generated pseudonyms", () => {
      const session = makeSession(id)
      session.remember("Emily Brontë", "person_1")
      expect(session.scrubText("The author is Emily Brontë")).toBe("The author is person_1")
      expect(session.resolveText("The author is person_1")).toBe("The author is Emily Brontë")
    })

    it("different seeds produce different hashes for same value", () => {
      const s1 = new PseudonymStore(randomBytes(16).toString("hex"))
      const s2 = new PseudonymStore(randomBytes(16).toString("hex"))
      const h1 = s1.pseudonymize("Emily Brontë", "name")
      const h2 = s2.pseudonymize("Emily Brontë", "name")
      expect(h1).not.toBe(h2)
    })

    it("loads mappings from graph state", async () => {
      const first = await sendMessage("pseudo-book", "Who wrote these books?")
      expect(first.status).toBe(200)
      const contextId = first.data.result.contextId
      const graphThreadId = `PseudoBookService:${contextId}`

      const firstState = await latestMaskingState(graphThreadId)
      const firstHash = [...firstState.hashToOriginal.entries()].find(
        ([, value]) => value === "Emily Brontë",
      )?.[0]
      expect(firstHash).toMatch(/^name-[0-9a-f]{8}$/)

      // Second call with same contextId: seed + hashToOriginal must be preserved in state.
      const second = await sendMessage("pseudo-book", "Who wrote these books?", { contextId })
      expect(second.status).toBe(200)

      const secondState = await latestMaskingState(graphThreadId)
      expect(secondState.hashToOriginal.get(firstHash)).toBe("Emily Brontë")
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
    const id = `session-collision-${Date.now()}`
    afterEach(() => dropSession(id))

    it("scrubText handles a value that is a substring of another", () => {
      const session = makeSession(id)
      const hShort = session.pseudonymize("Emily", "name")
      const hLong = session.pseudonymize("Emily Brontë", "name")
      // "Emily Brontë" must map to its own hash, not "<hashEmily> Brontë"
      expect(session.scrubText("Emily Brontë")).toBe(hLong)
      expect(session.scrubText("Emily")).toBe(hShort)
    })

    it("resolveText resolves multiple hashes regardless of order", () => {
      const session = makeSession(id)
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
      expect(_shouldHash({ type: "cds.Integer", _foreignKey4: "author" })).toBe(true)
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
    const id = `session-pdata-${Date.now()}`
    afterEach(() => dropSession(id))

    it("hashes annotated fields in a row array in place", () => {
      const session = makeSession(id)
      const rows = [
        { name: "Emily", ID: 1 },
        { name: "Charlotte", ID: 2 },
      ]
      _pseudonymizeData(rows, new Set(["name"]), session)
      expect(rows[0].name).toMatch(/^name-[0-9a-f]{8}$/)
      expect(rows[0].ID).toBe(1) // untouched
      expect(session.resolve(rows[0].name)).toBe("Emily")
    })

    it("handles a single object and null values", () => {
      const session = makeSession(id)
      const row = { name: "Emily", nick: null }
      _pseudonymizeData(row, new Set(["name", "nick"]), session)
      expect(row.name).toMatch(/^name-/)
      expect(row.nick).toBeNull() // null skipped
    })

    it("no-op when annotated set is empty", () => {
      const session = makeSession(id)
      const rows = [{ name: "Emily" }]
      _pseudonymizeData(rows, new Set(), session)
      expect(rows[0].name).toBe("Emily")
    })
  })

  describe("_resolveArgs", () => {
    const { resolveArgs: _resolveArgs } = pseudo
    const id = `session-rargs-${Date.now()}`
    afterEach(() => dropSession(id))

    it("resolves a hash embedded inside a CQL string arg", () => {
      const session = makeSession(id)
      const hash = session.pseudonymize("Emily Brontë", "name")
      const args = { cql: `SELECT ID FROM Authors WHERE name = '${hash}'` }
      const resolved = _resolveArgs(args, session)
      expect(resolved.cql).toBe("SELECT ID FROM Authors WHERE name = 'Emily Brontë'")
    })

    it("resolves hashes in nested objects and arrays", () => {
      const session = makeSession(id)
      const hash = session.pseudonymize("Emily", "name")
      const args = { filter: { names: [hash, "plain"] }, count: 3 }
      const resolved = _resolveArgs(args, session)
      expect(resolved.filter.names[0]).toBe("Emily")
      expect(resolved.filter.names[1]).toBe("plain")
      expect(resolved.count).toBe(3) // non-string untouched
    })
  })

  describe("discoverElementsToBeMasked", () => {
    const { discoverElementsToBeMasked } = pseudo
    const fields = (cql, service = "CatalogService") =>
      [...discoverElementsToBeMasked(cds.model, { name: service }, cql, true)].sort((a, b) =>
        String(a).localeCompare(String(b)),
      )

    // [label, cql, expectedFields, service?]
    const cases = [
      // ── plain columns ──────────────────────────────────────────────────────
      [
        "plain columns",
        "SELECT ID, name, placeOfBirth FROM CatalogService.Authors",
        ["name", "placeOfBirth"],
      ],
      [
        "alias replaces element name in result",
        "SELECT ID, name as authorName FROM CatalogService.Authors",
        ["authorName"],
      ],
      ["SELECT *", "SELECT * FROM CatalogService.Authors", ["name", "placeOfBirth"]],
      [
        "non-hashable Date column ignored even when aliased",
        "SELECT ID, dateOfBirth as dob FROM CatalogService.Authors",
        [],
      ],
      // ── navigation paths ───────────────────────────────────────────────────
      [
        "navigation path with alias (author.name as author)",
        "SELECT title, author.name as author, price FROM AdminService.Books",
        ["author"],
        "AdminService",
      ],
      [
        "navigation path without alias",
        "SELECT title, author.name FROM AdminService.Books",
        ["name"],
        "AdminService",
      ],
      // ── subqueries ─────────────────────────────────────────────────────────
      [
        "subquery: outer name matches inner element name directly",
        "SELECT name FROM (SELECT ID, name FROM CatalogService.Authors)",
        ["name"],
      ],
      [
        "subquery: outer name matches inner alias",
        "SELECT ab FROM (SELECT name as ab FROM CatalogService.Authors)",
        ["ab"],
      ],
      [
        "subquery: outer name matches inner navigation-path alias",
        "SELECT ab FROM (SELECT author.name as ab FROM AdminService.Books)",
        ["ab"],
        "AdminService",
      ],
      // ── joins ──────────────────────────────────────────────────────────────
      [
        "join: annotated column from joined entity (inner join)",
        "SELECT b.title, a.name FROM CatalogService.Books as b " +
          "INNER JOIN CatalogService.Authors as a ON b.author_ID = a.ID",
        ["name"],
      ],
      [
        "join: alias on joined column (left join)",
        "SELECT a.name as writer FROM CatalogService.Books as b " +
          "LEFT JOIN CatalogService.Authors as a ON b.author_ID = a.ID",
        ["writer"],
      ],
      [
        "join: unqualified column binds to the source that has it",
        "SELECT title, name FROM CatalogService.Books as b " +
          "JOIN CatalogService.Authors as a ON b.author_ID = a.ID",
        ["name"],
      ],
      [
        "join: annotated columns across 3-way join (PII in last join)",
        "SELECT b.title, g.code, a.name FROM CatalogService.Books as b " +
          "LEFT JOIN CatalogService.Genres as g ON b.genre_code = g.code " +
          "LEFT JOIN CatalogService.Authors as a ON b.author_ID = a.ID",
        ["name"],
      ],
      [
        "join: annotated columns across 3-way join (PII in first join)",
        "SELECT a.name, a.placeOfBirth FROM CatalogService.Books as b " +
          "LEFT JOIN CatalogService.Authors as a ON b.author_ID = a.ID " +
          "LEFT JOIN CatalogService.Genres as g ON b.genre_code = g.code",
        ["name", "placeOfBirth"],
      ],
      [
        "join: SELECT * collects annotated elements from all joined entities",
        "SELECT * FROM CatalogService.Books as b " +
          "JOIN CatalogService.Authors as a ON b.author_ID = a.ID",
        ["authorName", "name", "placeOfBirth"],
      ],
      // ── union ──────────────────────────────────────────────────────────────
      [
        "union: name is PII because Authors branch has @PersonalData on name",
        "SELECT name FROM CatalogService.Books UNION SELECT name FROM CatalogService.Authors",
        ["name"],
      ],
      [
        "union: only the PII branch column is returned even when columns differ",
        "SELECT title FROM CatalogService.Books UNION SELECT name FROM CatalogService.Authors",
        ["name"],
      ],
      // ── join in subselect ──────────────────────────────────────────────────
      [
        "subquery with inner join: alias resolves through join to annotated element",
        "SELECT ab FROM (SELECT a.name as ab FROM CatalogService.Books as b " +
          "JOIN CatalogService.Authors as a ON b.author_ID = a.ID)",
        ["ab"],
      ],
      // ── expand ─────────────────────────────────────────────────────────────
      [
        'expand: author { name } — path array ["author","name"] returned',
        "SELECT author { name } FROM AdminService.Books",
        [["author", "name"]],
        "AdminService",
      ],
      [
        "expand in expand: author { name, books { title } } — only author.name is PII",
        "SELECT author { name, books { title } } FROM AdminService.Books",
        [["author", "name"]],
        "AdminService",
      ],
      [
        "expand in expand: author { contact { email } } — inner expand has PII",
        "SELECT author { contact { email } } FROM AdminService.Books",
        [["author", "contact", "email"]],
        "AdminService",
      ],
      [
        "expand 3 levels deep: author { books { author { name } } }",
        "SELECT author { books { author { name } } } FROM AdminService.Books",
        [["author", "books", "author", "name"]],
        "AdminService",
      ],
      // ── complex / arrayed element types on the queried entity ────────────────
      // CAP flattens struct-typed elements in the runtime model (address → address_street,
      // address_geo_lat, address_region_district, …), so nested-struct PII surfaces as
      // flat scalar columns. Arrays of scalars and arrays of structs are NOT flattened.
      [
        "flattened complex type: SELECT flattened struct column is PII",
        "SELECT address_street FROM AdminService.Profiles",
        ["address_street"],
        "AdminService",
      ],
      [
        "scalar-array element: SELECT nicknames (many String) → single path",
        "SELECT nicknames FROM AdminService.Profiles",
        [["nicknames"]],
        "AdminService",
      ],
      [
        "scalar-array element: SELECT pastCities (array of String) → single path",
        "SELECT pastCities FROM AdminService.Profiles",
        [["pastCities"]],
        "AdminService",
      ],
      [
        "arrayed struct element: SELECT contacts → path into item's PII field",
        "SELECT contacts FROM AdminService.Profiles",
        [["contacts", "email"]],
        "AdminService",
      ],
      [
        "SELECT * over entity with complex (flattened) + arrayed + struct-array PII",
        "SELECT * FROM AdminService.Profiles",
        [
          "address_geo_lat",
          "address_region_district",
          "address_street",
          ["contacts", "email"],
          "name",
          "nicknames",
          "pastCities",
        ],
        "AdminService",
      ],
      // scalar subselect with inner join — cds.ql resolves element but loses PII;
      // must fall back to _discoverFromCqn on the subselect
      [
        "scalar subselect with inner join: name from Authors via join is PII",
        "SELECT (SELECT a.name FROM CatalogService.Books as b " +
          "JOIN CatalogService.Authors as a ON b.author_ID = a.ID WHERE b.ID = ID) as authorName " +
          "FROM CatalogService.Books",
        ["authorName"],
      ],
      // ── Special cases ─────────────────────────────────
      [
        "union within subquery: name is PII via Authors branch",
        "SELECT name FROM (SELECT name FROM CatalogService.Books UNION SELECT name FROM CatalogService.Authors)",
        ["name"],
      ],
      // scalar subselect as a column expression with alias: result key is the outer alias
      [
        "scalar subselect in column list: name selected from Authors is PII",
        "SELECT ID, (SELECT name FROM CatalogService.Authors as a WHERE a.ID = author_ID) as authorName FROM CatalogService.Books",
        ["authorName"],
      ],
      [
        "nested subselect (subselect of subselect): alias ab resolves to name in Authors",
        "SELECT ab FROM (SELECT name as ab FROM (SELECT name FROM CatalogService.Authors))",
        ["ab"],
      ],
      [
        "subselect inside expand: scalar subselect with alias selecting PII field",
        "SELECT author { (SELECT name FROM CatalogService.Authors as a WHERE a.ID = ID) as ab } FROM AdminService.Books",
        [["author", "ab"]],
        "AdminService",
      ],
      // ── expressions and functions (not yet supported — document gaps) ───────
      // xpr: (name || '123') as ab — ref inside xpr array carries PII field
      [
        "xpr: string concat expression with PII field → result key is alias",
        "SELECT (name || '123') as ab FROM CatalogService.Authors",
        ["ab"],
      ],
      // func: min(name) — aggregate function wrapping a PII field
      [
        "func: aggregate min(name) as minName → result key is alias",
        "SELECT min(name) as minName FROM CatalogService.Authors",
        ["minName"],
      ],
      // func wrapping a subselect that selects a PII field
      [
        "func wrapping subselect: upper((SELECT name FROM Authors)) as ab",
        "SELECT upper((SELECT name FROM CatalogService.Authors as a WHERE a.ID = author_ID)) as ab FROM CatalogService.Books",
        ["ab"],
      ],
      // func with a joined prop: upper(a.name) — ref inside func.args has table alias + element
      [
        "func with joined prop: upper(a.name) as ab",
        "SELECT upper(a.name) as ab FROM CatalogService.Books as b " +
          "JOIN CatalogService.Authors as a ON b.author_ID = a.ID",
        ["ab"],
      ],
      // nested funcs with joined prop: upper(lower(a.name)) — ref inside inner func.args
      [
        "nested funcs with joined prop: upper(lower(a.name)) as ab",
        "SELECT upper(lower(a.name)) as ab FROM CatalogService.Books as b " +
          "JOIN CatalogService.Authors as a ON b.author_ID = a.ID",
        ["ab"],
      ],
    ]

    it.each(cases)("%s", (label, cql, expected, service) => {
      expect(fields(cql, service)).toEqual(expected)
    })
  })

  // ─── E2E: full middleware hook flow ─────────────────────────────────────────
  describe("middleware E2E", () => {
    let maskingMiddleware, encode, HumanMessage, AIMessage, ToolMessage
    const srvName = "CatalogService"
    const contextId = `e2e-${Date.now()}`

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
      ;({ default: maskingMiddleware } = await import("../../lib/agents/middleware/masking.js"))
      ;({ encode } = await import("@toon-format/toon"))
      ;({ HumanMessage, AIMessage, ToolMessage } = await import("@langchain/core/messages"))
    })

    afterEach(() => {
      cds.context && (cds.context["agent.pseudonyms"] = undefined)
    })

    async function setupContext(service = srvName) {
      const srv = cds.services[service]
      cds.env.agents ??= {}
      cds.env.agents.masking ??= true
      const mw = maskingMiddleware(srv)
      cds.context = cds.context || {}
      cds.context.model = cds.model
      cds.context["agent.service"] = service
      cds.context["agent.context.id"] = contextId
      cds.context["agent.pseudonyms"] = undefined
      // beforeAgent creates the session from state and stashes it on cds.context.
      await mw.beforeAgent({ seed: randomBytes(16).toString("hex"), hashToOriginal: new Map() })
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
      const content = getContent(result)

      // originals must not appear; hashes must
      expect(content).not.toContain("Emily Brontë")
      expect(content).toContain("name-")
      expect(content).toContain("placeOfBirth-")
      // ID is a key Integer → not annotated with @PersonalData → untouched
      expect(content).toContain("1")

      const emilyHash = [...cds.context["agent.pseudonyms"]._hashToOriginal].find(
        ([, original]) => original === "Emily Brontë",
      )?.[0]
      expect(emilyHash).toBeDefined()
    })

    it("query result with flattened struct, scalar arrays, and arrayed struct is fully masked", async () => {
      // AdminService.Profiles: flattened struct cols (address_street, address_geo_lat,
      // address_region_district), scalar arrays (nicknames, pastCities), arrayed struct
      // (contacts[].email). Every PII must be hashed; non-PII left intact.
      const { mw } = await setupContext("AdminService")
      const rawContent = encode({
        data: [
          {
            ID: 1,
            name: "Emily Brontë",
            address_street: "Market Street",
            address_city: "Thornton",
            address_geo_lat: "53.79",
            address_region_district: "Yorkshire",
            nicknames: ["Emmy", "Bell"],
            pastCities: ["Haworth", "Cowan Bridge"],
            contacts: [
              { email: "emily@moors.uk", label: "home" },
              { email: "eb@press.uk", label: "work" },
            ],
          },
        ],
      })
      const request = {
        toolCall: {
          name: "query",
          id: "tc1",
          args: {
            cql:
              "SELECT ID, name, address_street, address_city, address_geo_lat, " +
              "address_region_district, nicknames, pastCities, contacts FROM AdminService.Profiles",
          },
        },
        tool: {},
      }
      const result = await mw.wrapToolCall(
        request,
        async () => new ToolMessage({ content: rawContent, tool_call_id: "tc1", name: "query" }),
      )
      const content = getContent(result)

      // all PII originals gone
      for (const pii of [
        "Emily Brontë",
        "Market Street",
        "53.79",
        "Yorkshire",
        "Emmy",
        "Bell",
        "Haworth",
        "Cowan Bridge",
        "emily@moors.uk",
        "eb@press.uk",
      ]) {
        expect(content, `PII must be masked: ${pii}`).not.toContain(pii)
      }
      // non-PII intact
      expect(content).toContain("Thornton") // address_city not annotated
      expect(content).toContain("home") // contacts.label not annotated
      expect(content).toContain("work")
      // hash tokens present for the various PII kinds
      expect(content).toMatch(/name-[0-9a-f]{8}/)
      expect(content).toMatch(/address_street-[0-9a-f]{8}/)
      expect(content).toMatch(/address_geo_lat-[0-9a-f]{8}/)
      expect(content).toMatch(/address_region_district-[0-9a-f]{8}/)
      expect((content.match(/nicknames-[0-9a-f]{8}/g) || []).length).toBe(2)
      expect((content.match(/pastCities-[0-9a-f]{8}/g) || []).length).toBe(2)
      expect((content.match(/email-[0-9a-f]{8}/g) || []).length).toBe(2)
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
      const hash = getContent(toolMsg).match(/name-[0-9a-f]{8}/)[0]

      // model may echo the hash; GraphExecutor resolves it back before publishing.
      const session = cds.context["agent.pseudonyms"]
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
      const content = getContent(result)

      // annotated name → hashed; unannotated email → untouched
      expect(content).not.toContain("Emily Brontë")
      expect(content).toContain("name-")
      expect(content).toContain("1818-07-30")

      // hash resolves back to the original
      const session = cds.context["agent.pseudonyms"]
      const hash = content.match(/name-[0-9a-f]{8}/)[0]
      expect(session.resolve(hash)).toBe("Emily Brontë")
    })

    // ── complex action/function return types ─────────────────────────────────
    // Actions walk the return-type definition recursively, covering nested structs,
    // arrays, named types, and arrayed scalars — beyond flat query field discovery.
    const runAction = async (mw, toolName, data) => {
      const rawContent = encode({ data })
      const request = { toolCall: { name: toolName, id: "tc1", args: {} }, tool: {} }
      const result = await mw.wrapToolCall(
        request,
        async () => new ToolMessage({ content: rawContent, tool_call_id: "tc1", name: toolName }),
      )
      return getContent(result)
    }

    it("action returns a top-level scalar PII String — hashes using the tool name as prefix", async () => {
      const { mw } = await setupContext()
      const content = await runAction(mw, "authorName", "Emily Brontë")
      expect(content).not.toContain("Emily Brontë")
      expect(content).toMatch(/authorName-[0-9a-f]{8}/)
      const session = cds.context["agent.pseudonyms"]
      const hash = content.match(/authorName-[0-9a-f]{8}/)[0]
      expect(session.resolve(hash)).toBe("Emily Brontë")
    })

    it("action returns top-level scalar @Common.Masked String — still hashed for the LLM", async () => {
      // @Common.Masked (=true) means normal masking applies; only @Common.Masked:false
      // would let the LLM see the raw value. forLlm defaults to true here.
      const { mw } = await setupContext()
      const content = await runAction(mw, "authorSecret", "Ellis Bell")
      expect(content).not.toContain("Ellis Bell")
      expect(content).toMatch(/authorSecret-[0-9a-f]{8}/)
    })

    it("action returns top-level array of scalar PII String — hashes every item", async () => {
      // `array of String @PersonalData` puts the annotation on the arrayed node itself,
      // not on the item type — every scalar item must still be hashed.
      const { mw } = await setupContext()
      const content = await runAction(mw, "authorAllNames", ["Emily Brontë", "Charlotte Brontë"])
      expect(content).not.toContain("Emily Brontë")
      expect(content).not.toContain("Charlotte Brontë")
      expect((content.match(/authorAllNames-[0-9a-f]{8}/g) || []).length).toBe(2)
    })

    it("action returns object with a `many String` PII field — hashes every array element", async () => {
      const { mw } = await setupContext()
      const content = await runAction(mw, "authorWithNicknames", {
        name: "Emily Brontë",
        nicknames: ["Emmy", "Bell"],
      })
      expect(content).not.toContain("Emily Brontë")
      expect(content).not.toContain("Emmy")
      expect(content).not.toContain("Bell")
      expect(content).toMatch(/name-[0-9a-f]{8}/)
      expect((content.match(/nicknames-[0-9a-f]{8}/g) || []).length).toBe(2)
    })

    it("action returns array of struct — hashes annotated field in every item", async () => {
      const { mw } = await setupContext()
      const content = await runAction(mw, "listAuthorNames", [
        { name: "Emily Brontë" },
        { name: "Edgar Allen Poe" },
      ])
      expect(content).not.toContain("Emily Brontë")
      expect(content).not.toContain("Edgar Allen Poe")
      expect((content.match(/name-[0-9a-f]{8}/g) || []).length).toBe(2)
    })

    it("action returns array of multi-field struct — hashes only annotated fields", async () => {
      const { mw } = await setupContext()
      const content = await runAction(mw, "listAuthorContacts", [
        { name: "Emily Brontë", city: "Thornton", country: "England" },
      ])
      expect(content).not.toContain("Emily Brontë")
      expect(content).not.toContain("Thornton")
      expect(content).toContain("England") // country not annotated
      expect(content).toMatch(/name-[0-9a-f]{8}/)
      expect(content).toMatch(/city-[0-9a-f]{8}/)
    })

    it("action returns nested struct — hashes annotated field in the nested object", async () => {
      const { mw } = await setupContext()
      const content = await runAction(mw, "authorProfile", {
        name: "Emily Brontë",
        address: { street: "Market Street", city: "Thornton" },
      })
      expect(content).not.toContain("Emily Brontë")
      expect(content).not.toContain("Market Street")
      expect(content).toContain("Thornton") // address.city not annotated
      expect((content.match(/(?:name|street)-[0-9a-f]{8}/g) || []).length).toBe(2)
    })

    it("action returns a named complex type — resolves and hashes nested + arrayed PII", async () => {
      const { mw } = await setupContext()
      const content = await runAction(mw, "authorDossier", {
        name: "Emily Brontë",
        biography: "English novelist",
        contact: { email: "emily@moors.uk", phone: "555-0100" },
        aliases: [{ alias: "Ellis Bell" }],
      })
      expect(content).not.toContain("Emily Brontë")
      expect(content).not.toContain("emily@moors.uk")
      expect(content).not.toContain("Ellis Bell")
      expect(content).toContain("English novelist") // biography not annotated
      expect(content).toContain("555-0100") // phone not annotated
      expect(content).toMatch(/name-[0-9a-f]{8}/)
      expect(content).toMatch(/email-[0-9a-f]{8}/)
      expect(content).toMatch(/alias-[0-9a-f]{8}/)
    })

    it("action returns arrayed nested struct — hashes annotated field in every nested item", async () => {
      const { mw } = await setupContext()
      const content = await runAction(mw, "authorWithHistory", {
        name: "Emily Brontë",
        addresses: [
          { street: "Market Street", city: "Thornton" },
          { street: "Church Lane", city: "Haworth" },
        ],
      })
      expect(content).not.toContain("Emily Brontë")
      expect(content).not.toContain("Market Street")
      expect(content).not.toContain("Church Lane")
      expect(content).toContain("Thornton") // city not annotated
      expect(content).toContain("Haworth")
      // 1 name + 2 street hashes
      expect((content.match(/(?:name|street)-[0-9a-f]{8}/g) || []).length).toBe(3)
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
      const content = getContent(result)

      // aliased personal-data column must still be hashed (no PII leak)
      expect(content).not.toContain(author)
      // hash prefix uses the alias (the result key)
      expect(content).toMatch(/authorName-[0-9a-f]{8}/)

      const session = cds.context["agent.pseudonyms"]
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
      const content = getContent(result)

      // annotated joined column hashed; non-personal title untouched
      expect(content).not.toContain(author)
      expect(content).toContain("Wuthering Heights")
      expect(content).toMatch(/name-[0-9a-f]{8}/)

      const session = cds.context["agent.pseudonyms"]
      const hash = content.match(/name-[0-9a-f]{8}/)[0]
      expect(session.resolve(hash)).toBe(author)
    })

    it("pseudonymizes numeric foreign keys and keys", async () => {
      // Customers.ID is Integer + key:true + @PersonalData.IsPotentiallyPersonal
      // shouldHash returns true for numeric when el.key is set, so the ID must be hashed.
      const { mw } = await setupContext()
      const rawContent = encode({
        data: [
          { ID: 1001, name: "Alice Reader", favoriteAuthor_ID: 101 },
          { ID: 1002, name: "Bob Bookworm", favoriteAuthor_ID: 107 },
        ],
      })
      const request = {
        toolCall: {
          name: "query",
          id: "tc1",
          args: { cql: "SELECT ID, name, favoriteAuthor_ID FROM PseudoBookService.Customers" },
        },
        tool: {},
      }
      const result = await mw.wrapToolCall(
        request,
        async () => new ToolMessage({ content: rawContent, tool_call_id: "tc1", name: "query" }),
      )
      const content = getContent(result)

      // Numeric IDs must be pseudonymized — raw integers must not appear
      expect(content).not.toContain("1001")
      expect(content).not.toContain("1002")
      // Hash tokens for ID and name must be present
      expect(content).toMatch(/ID-[0-9a-f]{8}/)
      expect(content).toMatch(/name-[0-9a-f]{8}/)

      // Hashes resolve back to originals
      const session = cds.context["agent.pseudonyms"]
      const idHash = content.match(/ID-[0-9a-f]{8}/)[0]
      expect(session.resolve(idHash)).toBe("1001")
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
    cds.env.agents.masking = true
    setupTraceScrubbing()
    // Enable debug logging so gen_ai.tool.call.arguments and gen_ai.tool.call.result
    // attrs fire — these carry resolved (real) PII and must be scrubbed by the span processor.
    cds.log("agents", { level: "debug" })
    cds.env.agents.mlflow = true
  })
  after(async () => {
    cds.env.agents.masking = false
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

describe("pseudonymization — remote MCP tool name prefix", () => {
  const { axios: axiosInst } = cds.test(import.meta.dirname + "/../projects/bookshop")
  axiosInst.defaults.validateStatus = () => true

  let maskingMw, encode, ToolMessage

  beforeAll(async () => {
    ;({ default: maskingMw } = await import("../../lib/agents/middleware/masking.js"))
    ;({ encode } = await import("@toon-format/toon"))
    ;({ ToolMessage } = await import("@langchain/core/messages"))
    cds.env.agents ??= {}
    cds.env.agents.masking = true
  })

  afterAll(() => {
    cds.env.agents.masking = false
  })

  async function setupRemoteMcpContext() {
    const srv = cds.services["CatalogService"]
    const mw = maskingMw(srv)
    cds.context = cds.context || {}
    cds.context.model = cds.model
    cds.context["agent.service"] = "CatalogService"
    cds.context["agent.context.id"] = `remote-mcp-${Date.now()}`
    cds.context["agent.pseudonyms"] = undefined
    // __mcpDynamicTools mirrors what remoteMcpMiddleware caches after tools/list.
    cds.context.__mcpDynamicTools = {
      "http://mock-mcp/mcp": {
        serviceName: "CatalogService",
        tools: [{ name: "catalogservice_query" }, { name: "catalogservice_findauthor" }],
      },
    }
    await mw.beforeAgent({ seed: randomBytes(16).toString("hex"), hashToOriginal: new Map() })
    return { mw }
  }

  afterEach(() => {
    if (cds.context) cds.context["agent.pseudonyms"] = undefined
  })

  it("prefixed query tool 'catalogservice_query' is pseudonymized after fix", async () => {
    const { mw } = await setupRemoteMcpContext()
    const rawContent = encode({
      data: [{ ID: 1, name: "Emily Brontë", placeOfBirth: "Thornton" }],
    })
    const request = {
      toolCall: {
        name: "catalogservice_query",
        id: "tc1",
        args: { cql: "SELECT ID, name, placeOfBirth FROM CatalogService.Authors" },
      },
      tool: {},
    }
    const result = await mw.wrapToolCall(
      request,
      async () =>
        new ToolMessage({ content: rawContent, tool_call_id: "tc1", name: "catalogservice_query" }),
    )
    expect(getContent(result)).not.toContain("Emily Brontë")
    expect(getContent(result)).toMatch(/name-[0-9a-f]{8}/)
    expect(getContent(result)).toMatch(/placeOfBirth-[0-9a-f]{8}/)
  })

  it("prefixed action 'catalogservice_findauthor' is pseudonymized after fix", async () => {
    const { mw } = await setupRemoteMcpContext()
    const rawContent = encode({
      data: { name: "Emily Brontë", dateOfBirth: "1818-07-30" },
    })
    const request = {
      toolCall: {
        name: "catalogservice_findauthor",
        id: "tc1",
        args: { searchTerm: "Emily" },
      },
      tool: {},
    }
    const result = await mw.wrapToolCall(
      request,
      async () =>
        new ToolMessage({
          content: rawContent,
          tool_call_id: "tc1",
          name: "catalogservice_findauthor",
        }),
    )
    expect(getContent(result)).not.toContain("Emily Brontë")
    expect(getContent(result)).toMatch(/name-[0-9a-f]{8}/)
    expect(getContent(result)).toContain("1818-07-30") // dateOfBirth not annotated
  })
})
