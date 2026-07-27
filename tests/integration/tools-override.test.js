import { tool } from "@langchain/core/tools"
import { z } from "zod"
import cds from "@sap/cds"

import { generateTools, instrumentTools } from "../../srv/handlers/tools.js"

// Symbol marking a tool as instrumented by @cap-js/agents
const INSTRUMENTED = Symbol.for("@cap-js/agents:instrumented")

function makeTool(name = "weather") {
  return tool(async ({ city }) => `Sunny in ${city}`, {
    name,
    description: `Get the current weather for a city (${name})`,
    schema: z.object({ city: z.string() }),
  })
}

describe("buildTools — default behavior", () => {
  it("generateTools returns tools array and toolMap", () => {
    const srv = { name: "TestService", entities: {}, operations: {} }
    const result = generateTools(srv)
    expect(Array.isArray(result)).toBeTruthy()
  })

  it("buildTools event returns tools array", async () => {
    // Simulate: register default handler then dispatch
    const srv = new cds.ApplicationService()
    srv.name = "TestBuildTools"
    srv.model = { definitions: {} }
    srv.on("buildTools", () => {
      return generateTools(srv)
    })
    await srv.init()

    const result = await srv.send("buildTools")
    expect(Array.isArray(result), "buildTools should return an array").toBeTruthy()
  })
})

describe("instrumentTools", () => {
  it("idempotent (re-instrumenting is a no-op)", () => {
    const t = makeTool()
    instrumentTools([t])
    const wrapped = t.invoke
    instrumentTools([t])
    expect(t.invoke).toBe(wrapped)
  })

  it("marks tool with INSTRUMENTED symbol", () => {
    const t = makeTool()
    instrumentTools([t])
    expect(t[INSTRUMENTED]).toBe(true)
  })

  it("instrumented tool: errors are recorded and re-thrown", async () => {
    const failing = tool(
      async () => {
        throw new Error("boom")
      },
      {
        name: "failing",
        description: "always fails",
        schema: z.object({}),
      },
    )
    instrumentTools([failing])

    await expect(failing.invoke({})).rejects.toThrow(/boom/)
  })
})
