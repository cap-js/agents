import cds from "@sap/cds"
import { registerCompileTargets } from "../../lib/api.cjs"

describe("@cap-js/agents - a2a compile target", () => {
  beforeAll(() => registerCompileTargets)

  it("registers cds.compile.to.a2a as a function", () => {
    expect(typeof cds.compile.to.a2a).toBe("function")
  })

  it("compiles an @agent service to an agent card object", () => {
    const csn = cds.linked(`
      @agent
      @protocol: 'agent'
      service MyAgentService {
        entity Items { key ID: UUID; name: String; }
      }
    `)

    const card = cds.compile.to.a2a(csn, { as: "json" })
    expect(card).toBeTypeOf("object")
    expect(card.name).toBe("MyAgentService")
    expect(Array.isArray(card.skills)).toBe(true)
  })
})
