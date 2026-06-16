import assert from "node:assert/strict"
import { describe, it, mock } from "node:test"
import { tool } from "@langchain/core/tools"
import { z } from "zod"

import { resolveTools, instrumentTools } from "../../srv/tools.js"

// Symbol marking a tool as instrumented by @cap-js/agent
const INSTRUMENTED = Symbol.for("@cap-js/agent:instrumented")

function makeTool(name = "weather") {
  return tool(async ({ city }) => `Sunny in ${city}`, {
    name,
    description: `Get the current weather for a city (${name})`,
    schema: z.object({ city: z.string() }),
  })
}

describe("resolveTools — srv.agent.tools override", () => {
  it("array form: full replace with single custom tool", async () => {
    const myTool = makeTool()
    const srv = { name: "TestService", agent: { tools: [myTool] } }

    const { tools, toolMap } = await resolveTools(srv)

    assert.strictEqual(tools.length, 1)
    assert.strictEqual(tools[0].name, "weather")
    assert.strictEqual(toolMap.weather, myTool)
    assert.strictEqual(myTool[INSTRUMENTED], true)
  })

  it("array form: empty array allowed (LLM-only mode)", async () => {
    const srv = { name: "TestService", agent: { tools: [] } }
    const { tools, toolMap } = await resolveTools(srv)
    assert.deepStrictEqual(tools, [])
    assert.deepStrictEqual(toolMap, {})
  })

  it("function form: factory called with {srv, generateTools}", async () => {
    const myTool = makeTool()
    const factory = mock.fn(({ srv, generateTools }) => {
      assert.strictEqual(srv.name, "TestService")
      assert.strictEqual(typeof generateTools, "function")
      return [myTool]
    })
    const srv = { name: "TestService", agent: { tools: factory } }

    const { tools } = await resolveTools(srv)

    assert.strictEqual(factory.mock.callCount(), 1)
    assert.strictEqual(tools.length, 1)
    assert.strictEqual(tools[0], myTool)
  })

  it("function form: async factory awaited", async () => {
    const myTool = makeTool()
    const srv = {
      name: "TestService",
      agent: { tools: async () => [myTool] },
    }
    const { tools } = await resolveTools(srv)
    assert.deepStrictEqual(tools, [myTool])
  })

  it("function form: throws when factory returns non-array", async () => {
    const srv = { name: "TestService", agent: { tools: () => "not-an-array" } }
    await assert.rejects(resolveTools(srv), /factory must return an array/)
  })

  it("validation: invalid type throws clear error", async () => {
    const srv = { name: "TestService", agent: { tools: 42 } }
    await assert.rejects(
      resolveTools(srv),
      /srv\.agent\.tools must be an array of LangChain tools or a factory function/,
    )
  })

  it("validation: tool item missing invoke throws", async () => {
    const broken = { name: "broken" }
    const srv = { name: "TestService", agent: { tools: [broken] } }
    await assert.rejects(resolveTools(srv), /invalid item|Invalid tool/)
  })

  it("validation: tool item missing name throws", async () => {
    const broken = { invoke: async () => "x" }
    const srv = { name: "TestService", agent: { tools: [broken] } }
    await assert.rejects(resolveTools(srv), /invalid item|Invalid tool/)
  })

  it("validation: duplicate tool names throw at startup", async () => {
    const a = makeTool("dup")
    const b = makeTool("dup")
    const srv = { name: "TestService", agent: { tools: [a, b] } }
    await assert.rejects(resolveTools(srv), /duplicate tool name "dup" for service "TestService"/)
  })

  it("undefined override: delegates to generateTools (default path)", async () => {
    // Mock minimal CDS service: no entities/actions => generateTools returns empty
    // checkAuthorization needs srv shape; with no entities/actions we expect graceful empty result
    const srv = {
      name: "TestService",
      entities: {},
      operations: {},
      agent: undefined, // no override
    }

    const result = await resolveTools(srv)
    assert.ok(Object.prototype.hasOwnProperty.call(result, "tools"))
    assert.ok(Object.prototype.hasOwnProperty.call(result, "toolMap"))
    assert.ok(Array.isArray(result.tools))
  })

  it("instrumentTools: idempotent (re-instrumenting is a no-op)", () => {
    const t = makeTool()
    instrumentTools([t])
    const wrapped = t.invoke
    instrumentTools([t]) // second call
    assert.strictEqual(t.invoke, wrapped) // not re-wrapped
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

    await assert.rejects(failing.invoke({}), /boom/)
  })
})
