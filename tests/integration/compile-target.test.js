import cds from "@sap/cds"
import { registerCompileTargets } from "../../lib/api.cjs"

describe("@cap-js/agents - a2a compile target", () => {
  beforeAll(registerCompileTargets)

  it("should register cds.compile.to.a2a as a function", () => {
    expect(typeof cds.compile.to.a2a).toBe("function")
  })

  describe("when the model is invalid", () => {
    it("should throw when no services are present", () => {
      const csn = cds.linked(`entity Orphan { key ID: UUID; }`)
      expect(() => cds.compile.to.a2a(csn, { as: "json" })).toThrow(
        "No service definitions found",
      )
    })

    it("should throw when multiple services exist and --service is not given", () => {
      const csn = cds.linked(`
        service ServiceA { entity Items { key ID: UUID; } }
        service ServiceB { entity Orders { key ID: UUID; } }
      `)
      expect(() => cds.compile.to.a2a(csn, { as: "json" })).toThrow(
        "Found multiple service definitions",
      )
    })

    it("should throw when --service names an unknown definition", () => {
      const csn = cds.linked(`service ServiceA { entity Items { key ID: UUID; } }`)
      expect(() => cds.compile.to.a2a(csn, { service: "NonExistent", as: "json" })).toThrow(
        "No service definition matching NonExistent",
      )
    })
  })

  describe("when correctly identifying the service to compile", () => {
    it("should compile the only service without requiring --service", () => {
      const csn = cds.linked(`service OnlyService { entity Items { key ID: UUID; } }`)
      const card = cds.compile.to.a2a(csn, { as: "json" })
      expect(card.name).toBe("OnlyService")
    })

    it("should compile only the named service when --service is given", () => {
      const csn = cds.linked(`
        service ServiceA { entity Items { key ID: UUID; } }
        service ServiceB { entity Orders { key ID: UUID; } }
      `)
      const card = cds.compile.to.a2a(csn, { service: "ServiceB", as: "json" })
      expect(card.name).toBe("ServiceB")
    })
  })

  describe("when generating the agent card", () => {
    let card

    beforeAll(() => {
      const csn = cds.linked(`
        @description: 'A test agent'
        service StructureTestService {
          entity Items { key ID: UUID; name: String; }
        }
      `)
      card = cds.compile.to.a2a(csn, { as: "json" })
    })

    it("should set name to the service name", () => {
      expect(card.name).toBe("StructureTestService")
    })

    it("should use the @description annotation as description", () => {
      expect(card.description).toBe("A test agent")
    })

    it("should fall back to 'Agent for {name}' when @description is absent", () => {
      const csn = cds.linked(`service BareService {}`)
      expect(cds.compile.to.a2a(csn, { as: "json" }).description).toBe("Agent for BareService")
    })

    it("should set protocolVersion, capabilities and IO modes to expected defaults", () => {
      expect(card.protocolVersion).toBe("0.3.0")
      expect(card.capabilities.streaming).toBe(true)
      expect(card.capabilities.pushNotifications).toBe(true)
      expect(card.defaultInputModes).toEqual(["text/plain"])
      expect(card.defaultOutputModes).toEqual(["text/plain"])
    })

    it("should set supportedInterfaces with matching url and JSONRPC binding at protocolVersion 0.3.0", () => {
      const [iface] = card.supportedInterfaces
      expect(iface.url).toBe(card.url)
      expect(iface.protocolBinding).toBe("JSONRPC")
      expect(iface.protocolVersion).toBe("0.3.0")
    })
  })

  describe("when deriving the agent URL", () => {
    it("should use the HOST placeholder and the slugified service name by default", () => {
      const csn = cds.linked(`service MyAgentService { entity Items { key ID: UUID; } }`)
      expect(cds.compile.to.a2a(csn, { as: "json" }).url).toBe("https://HOST/a2a/my-agent")
    })

    it("should prefer the @path value over the slugified service name", () => {
      const csn = cds.linked(`
        @path: '/custom-path'
        service AnyService { entity Items { key ID: UUID; } }
      `)
      expect(cds.compile.to.a2a(csn, { as: "json" }).url).toBe("https://HOST/a2a/custom-path")
    })

    it("should strip a leading slash from @path before appending it", () => {
      const csn = cds.linked(`
        @path: 'no-slash'
        service AnyService { entity Items { key ID: UUID; } }
      `)
      expect(cds.compile.to.a2a(csn, { as: "json" }).url).toBe("https://HOST/a2a/no-slash")
    })

    it("should use the @Core.Links rel=via href as proxy URL on both card.url and supportedInterfaces", () => {
      const csn = cds.linked(`
        @Core.Links: [{rel: 'via', href: 'https://proxy.example.com/agent'}]
        service ProxiedService { entity Items { key ID: UUID; } }
      `)
      const card = cds.compile.to.a2a(csn, { as: "json" })
      expect(card.url).toBe("https://proxy.example.com/agent")
      expect(card.supportedInterfaces[0].url).toBe("https://proxy.example.com/agent")
    })
  })

  describe("when generating skills", () => {
    it("should produce a query skill with correct id, name, and tags for entities", () => {
      const csn = cds.linked(`service S { entity Products { key ID: UUID; } }`)
      const q = cds.compile.to.a2a(csn, { as: "json" }).skills.find((s) => s.id === "query")
      expect(q).toBeDefined()
      expect(q.name).toBe("Data Query")
      expect(q.tags).toEqual(expect.arrayContaining(["query", "data", "read", "products"]))
    })

    it("should tag actions with hitl and functions without it", () => {
      const csnWithAction = cds.linked(`service S { action doWork(input: String) returns String; }`)
      const action = cds.compile.to.a2a(csnWithAction, { as: "json" }).skills.find((s) => s.id === "doWork")
      expect(action).toBeDefined()
      expect(action.tags).toEqual(expect.arrayContaining(["hitl", "action"]))

      const csnWithFunction = cds.linked(`service S { function getInfo() returns String; }`)
      const func = cds.compile.to.a2a(csnWithFunction, { as: "json" }).skills.find((s) => s.id === "getInfo")
      expect(func).toBeDefined()
      expect(func.tags).toContain("function")
      expect(func.tags).not.toContain("hitl")
    })

    it("should use the @description annotation as skill description", () => {
      const csn = cds.linked(`
        service S {
          @description: 'Submit a new order'
          action submitOrder(orderID: UUID) returns String;
        }
      `)
      const skill = cds.compile.to.a2a(csn, { as: "json" }).skills.find((s) => s.id === "submitOrder")
      expect(skill?.description).toBe("Submit a new order")
    })

    it("should produce an empty skills array when the service has no entities or actions", () => {
      const csn = cds.linked(`service EmptyService {}`)
      expect(cds.compile.to.a2a(csn, { as: "json" }).skills).toHaveLength(0)
    })

    it("should give every skill id, name, description, tags array, and examples array", () => {
      const csn = cds.linked(`
        service S {
          entity Items { key ID: UUID; }
          action doWork() returns String;
        }
      `)
      for (const skill of cds.compile.to.a2a(csn, { as: "json" }).skills) {
        expect(skill.id).toBeTypeOf("string")
        expect(skill.name).toBeTypeOf("string")
        expect(skill.description).toBeTypeOf("string")
        expect(Array.isArray(skill.tags)).toBe(true)
        expect(Array.isArray(skill.examples)).toBe(true)
      }
    })
  })

  describe("when formatting output", () => {
    it("should return a plain object when as: 'json' is set", () => {
      const csn = cds.linked(`service S { entity Items { key ID: UUID; } }`)
      const result = cds.compile.to.a2a(csn, { as: "json" })
      expect(result).toBeTypeOf("object")
      expect(result).not.toBeNull()
    })

    it("should return a formatted JSON string when stdout is not a TTY and as is not set", () => {
      if (process.stdout.isTTY) return

      const csn = cds.linked(`service S { entity Items { key ID: UUID; } }`)
      const result = cds.compile.to.a2a(csn, {})
      expect(result).toBeTypeOf("string")
      expect(JSON.parse(result)).toBeTypeOf("object")
    })
  })
})
