import cds from "@sap/cds"
import { registerCompileTargets } from "../../lib/api.cjs"

describe("a2a compile target", () => {
  beforeAll(registerCompileTargets)

  it("should register cds.compile.to.a2a as a function", () => {
    expect(typeof cds.compile.to.a2a).toBe("function")
  })

  describe("when the model is invalid", () => {
    it("should throw when no services are present", () => {
      const csn = cds.linked(`entity Orphan { key ID: UUID; }`)
      expect(() => cds.compile.to.a2a(csn, { as: "json" })).toThrow("No service definitions found")
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

  describe("when deriving the agent URL", () => {
    it("should use a relative URL with the slugified service name by default", () => {
      const csn = cds.linked(`service MyAgentService { entity Items { key ID: UUID; } }`)
      expect(cds.compile.to.a2a(csn, { as: "json" }).url).toBe("/a2a/my-agent")
    })

    it("should prefer the @path value over the slugified service name", () => {
      const csn = cds.linked(`
        @path: '/custom-path'
        service AnyService { entity Items { key ID: UUID; } }
      `)
      expect(cds.compile.to.a2a(csn, { as: "json" }).url).toBe("/a2a/custom-path")
    })

    it("should strip a leading slash from @path before appending it", () => {
      const csn = cds.linked(`
        @path: 'no-slash'
        service AnyService { entity Items { key ID: UUID; } }
      `)
      expect(cds.compile.to.a2a(csn, { as: "json" }).url).toBe("/a2a/no-slash")
    })

    it("should use the hostUrl option as the base of the agent URL", () => {
      const csn = cds.linked(`service AnyService { entity Items { key ID: UUID; } }`)
      const card = cds.compile.to.a2a(csn, { hostUrl: "https://my.host.com", as: "json" })
      expect(card.url).toBe("https://my.host.com/a2a/any")
    })

    it("should prepend https:// when hostUrl has no scheme", () => {
      const csn = cds.linked(`service AnyService { entity Items { key ID: UUID; } }`)
      expect(cds.compile.to.a2a(csn, { hostUrl: "my.host.com", as: "json" }).url).toBe(
        "https://my.host.com/a2a/any",
      )
    })

    it("should preserve an explicit http:// scheme in hostUrl", () => {
      const csn = cds.linked(`service AnyService { entity Items { key ID: UUID; } }`)
      expect(cds.compile.to.a2a(csn, { hostUrl: "http://my.host.com", as: "json" }).url).toBe(
        "http://my.host.com/a2a/any",
      )
    })

    it("should strip trailing slashes from hostUrl", () => {
      const csn = cds.linked(`service AnyService { entity Items { key ID: UUID; } }`)
      expect(cds.compile.to.a2a(csn, { hostUrl: "https://my.host.com//", as: "json" }).url).toBe(
        "https://my.host.com/a2a/any",
      )
    })
  })

  describe("when formatting output", () => {
    it("should return a plain object when as: 'json' is set", () => {
      const csn = cds.linked(`service S { entity Items { key ID: UUID; } }`)
      const result = cds.compile.to.a2a(csn, { as: "json" })
      expect(result).toBeTypeOf("object")
      expect(result).not.toBeNull()
    })

    it("should return a 2-space JSON string when neither as:json nor a TTY applies", () => {
      const originalTTY = process.stdout.isTTY
      process.stdout.isTTY = false

      try {
        const csn = cds.linked(`service S { entity Items { key ID: UUID; } }`)
        const result = cds.compile.to.a2a(csn, {})

        expect(result).toBeTypeOf("string")
        expect(result).toContain("\n  ") // 2-space indentation
        expect(JSON.parse(result).name).toBe("S")
      } finally {
        process.stdout.isTTY = originalTTY
      }
    })
  })
})
