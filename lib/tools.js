import cds from "@sap/cds"
import { DynamicStructuredTool } from "@langchain/core/tools"
import {
  createGenericReadToolDefinition,
  createDescribeToolDefinition,
  createCallActionToolDefinition,
  createPerActionToolDefinition,
  executeGenericReadTool,
  executeDescribe,
  executeCallActionTool,
  executePerActionTool,
} from "@cap-js/mcp/lib/tools.js"
import { checkAuthorization } from "@cap-js/mcp/lib/auth.js"
import { getFilteredEntities, getFilteredActions, audit } from "./utils.js"
import * as metrics from "./telemetry/metrics.js"
import { INSTRUMENTED } from "./telemetry/tracing.js"

const LOG = cds.log("a2a")

/**
 * Reuses tool definitions and execution logic from @cap-js/mcp
 *
 * @param {object} srv - CDS ApplicationService
 * @param {object} [options] - Options
 * @param {boolean} [options.skipAuth] - Skip authorization check (e.g. when generating tools at startup for custom graphs)
 */
export function generateTools(srv, options = {}) {
  let entities, actions

  // TODO: needs to be done differently
  if (options.skipAuth) {
    entities = getFilteredEntities(srv)
    actions = getFilteredActions(srv)
  } else {
    const authResult = checkAuthorization(srv)
    if (authResult.error) return { tools: [], toolMap: {} }
    entities = authResult.entities
    actions = authResult.actions
  }

  const tools = []
  const toolMap = {}

  function register(dstool) {
    // Wrap invoke to catch errors (become normal tool results the LLM can learn from)
    // and to create OTel spans + record metrics for each tool invocation.
    const originalInvoke = dstool.invoke.bind(dstool)
    dstool.invoke = async (args, config) => {
      const tracer = metrics.getTracer()
      const toolAttrs = {
        "sap.tenantId": cds.context?.tenant || "anonymous",
        "a2a.service": cds.context?.["a2a.service"],
        tool: dstool.name,
      }

      const invoke = async (span) => {
        if (span) {
          span.setAttribute("gen_ai.operation.name", "execute_tool")
          span.setAttribute("gen_ai.provider.name", "langchain")
          span.setAttribute("a2a.span.kind", "tool")
          span.setAttribute("a2a.tool.name", dstool.name)
          if (LOG._debug) {
            const input = JSON.stringify(args)
            span.setAttribute("a2a.entity.input", input)
          }
        }
        const t0 = Date.now()
        try {
          const result = await originalInvoke(args, config)
          const duration = Date.now() - t0
          metrics.toolInvocations.add(1, { ...toolAttrs, outcome: "success" })
          if (span) {
            span.setAttribute("a2a.tool.outcome", "success")
            if (LOG._debug) {
              const output = typeof result === "string" ? result : JSON.stringify(result)
              span.setAttribute("a2a.entity.output", output)
            }
          }

          // Audit: record tool invocation
          const taskId = config?.configurable?._taskId || cds.context?.["a2a.task.id"]
          if (taskId) {
            const resultStr = typeof result === "string" ? result : JSON.stringify(result)
            audit("ToolInvocation", {
              data: {
                taskId,
                service: config?.configurable?._service || cds.context?.["a2a.service"],
                tool: dstool.name,
                args,
                outcome: "success",
                result: resultStr?.slice(0, 2000),
                duration,
              },
            })
          }

          return result
        } catch (err) {
          const duration = Date.now() - t0
          metrics.toolInvocations.add(1, { ...toolAttrs, outcome: "error" })
          if (span) {
            span.setAttribute("a2a.tool.outcome", "error")
            span.setStatus({ code: 2, message: err.message })
          }

          // Audit: record failed tool invocation
          const taskId = config?.configurable?._taskId || cds.context?.["a2a.task.id"]
          if (taskId) {
            audit("ToolInvocation", {
              data: {
                taskId,
                service: config?.configurable?._service || cds.context?.["a2a.service"],
                tool: dstool.name,
                args,
                outcome: "error",
                error: err.message,
                duration,
              },
            })
          }

          return `Error: ${err.message}`
        }
      }

      if (tracer) {
        return tracer.startActiveSpan(
          `execute_tool DynamicStructuredTool ${dstool.name}`,
          async (span) => {
            try {
              return await invoke(span)
            } finally {
              span.end()
            }
          },
        )
      }
      return invoke(null)
    }
    dstool[INSTRUMENTED] = true
    tools.push(dstool)
    toolMap[dstool.name] = dstool
  }

  // Query tool — one tool for reading all entities
  const entityNames = Object.keys(entities)
  if (entityNames.length > 0) {
    const def = createGenericReadToolDefinition(entityNames, srv.name)
    register(
      new DynamicStructuredTool({
        name: def.name,
        description: def.description,
        schema: def.inputSchema,
        func: async (args) => {
          const result = await executeGenericReadTool(srv, entities, args)
          return result.content[0].text
        },
      }),
    )
  }

  // Describe tool — introspect service model
  const actionNames = Object.keys(actions)
  if (entityNames.length > 0 || actionNames.length > 0) {
    const def = createDescribeToolDefinition(entityNames, actionNames, srv.name)
    register(
      new DynamicStructuredTool({
        name: def.name,
        description: def.description,
        schema: def.inputSchema,
        func: async (args) => {
          const result = await executeDescribe(srv, entities, actions, args)
          return result.content[0].text
        },
      }),
    )
  }

  // Action/function tools — per-action (default) or combined call_action
  const usePerActionTools = cds.env.a2a?.per_action_tool !== false
  if (actionNames.length > 0) {
    if (usePerActionTools) {
      for (const [name, action] of Object.entries(actions)) {
        const def = createPerActionToolDefinition(name, action, srv.name)
        register(
          new DynamicStructuredTool({
            name: def.name,
            description: def.description,
            schema: def.inputSchema,
            func: async (args) => {
              const result = await executePerActionTool(srv, name, action, args)
              return result.content[0].text
            },
          }),
        )
      }
    } else {
      const def = createCallActionToolDefinition(actionNames, srv.name)
      register(
        new DynamicStructuredTool({
          name: def.name,
          description: def.description,
          schema: def.inputSchema,
          func: async (args) => {
            const result = await executeCallActionTool(srv, actions, args)
            return result.content[0].text
          },
        }),
      )
    }
  }

  return { tools, toolMap }
}

/**
 * Instrument a single tool instance for tracing, audit logging, and metrics.
 *
 * Use this for custom tools (created via `tool()`) or MCP tools whose `.invoke`
 * is overridden on the instance — cases where the prototype-level patch alone
 * cannot intercept the call.
 *
 * Unlike CDS tools (which swallow errors so the LLM can retry), this re-throws
 * errors after recording them. Wrap with a try/catch if you need error swallowing.
 *
 * @param {import("@langchain/core/tools").StructuredTool} t - Tool to instrument
 * @returns {import("@langchain/core/tools").StructuredTool} The same tool (mutated)
 */
export function instrumentTool(t) {
  if (t[INSTRUMENTED]) return t
  const originalInvoke = t.invoke.bind(t)

  t.invoke = async (args, config) => {
    const tracer = metrics.getTracer()
    const toolAttrs = {
      "sap.tenantId": cds.context?.tenant || "anonymous",
      "a2a.service": config?.configurable?._service || cds.context?.["a2a.service"],
      tool: t.name,
    }

    const invoke = async (span) => {
      if (span) {
        span.setAttribute("gen_ai.operation.name", "execute_tool")
        span.setAttribute("gen_ai.provider.name", "langchain")
        span.setAttribute("a2a.span.kind", "tool")
        span.setAttribute("a2a.tool.name", t.name)
        if (LOG._debug) span.setAttribute("a2a.entity.input", JSON.stringify(args))
      }
      const t0 = Date.now()
      try {
        const result = await originalInvoke(args, config)
        const duration = Date.now() - t0
        metrics.toolInvocations.add(1, { ...toolAttrs, outcome: "success" })
        if (span) {
          span.setAttribute("a2a.tool.outcome", "success")
          if (LOG._debug) {
            const output = typeof result === "string" ? result : JSON.stringify(result)
            span.setAttribute("a2a.entity.output", output)
          }
        }

        // Audit: record tool invocation
        const taskId = config?.configurable?._taskId || cds.context?.["a2a.task.id"]
        if (taskId) {
          const resultStr = typeof result === "string" ? result : JSON.stringify(result)
          audit("ToolInvocation", {
            data: {
              taskId,
              service: toolAttrs["a2a.service"],
              tool: t.name,
              args,
              outcome: "success",
              result: resultStr?.slice(0, 2000),
              duration,
            },
          })
        }

        return result
      } catch (err) {
        const duration = Date.now() - t0
        metrics.toolInvocations.add(1, { ...toolAttrs, outcome: "error" })
        if (span) {
          span.setAttribute("a2a.tool.outcome", "error")
          span.setStatus({ code: 2, message: err.message })
        }

        // Audit: record failed tool invocation
        const taskId = config?.configurable?._taskId || cds.context?.["a2a.task.id"]
        if (taskId) {
          audit("ToolInvocation", {
            data: {
              taskId,
              service: toolAttrs["a2a.service"],
              tool: t.name,
              args,
              outcome: "error",
              error: err.message,
              duration,
            },
          })
        }

        throw err
      }
    }

    if (tracer) {
      return tracer.startActiveSpan(
        `execute_tool DynamicStructuredTool ${t.name}`,
        async (span) => {
          try {
            return await invoke(span)
          } finally {
            span.end()
          }
        },
      )
    }
    return invoke(null)
  }

  t[INSTRUMENTED] = true
  return t
}

/**
 * Instrument multiple tools. Convenience wrapper around instrumentTool().
 *
 * @param {import("@langchain/core/tools").StructuredTool[]} tools - Tools to instrument
 * @returns {import("@langchain/core/tools").StructuredTool[]} The same tools (mutated)
 */
export function instrumentTools(tools) {
  tools.forEach(instrumentTool)
  return tools
}

/**
 * Resolve the tool list for a managed agent based on `srv.a2a.tools`.
 *
 * Resolution order:
 *   undefined  -> generateTools(srv)        (default: query, describe, per-action)
 *   array      -> use as-is (full replace)  — auto-instrumented for telemetry/audit
 *   function   -> await fn({ srv, generateTools }) (factory; user composes)
 *
 * @param {object} srv - CDS ApplicationService
 * @returns {Promise<{tools: object[], toolMap: Record<string, object>}>}
 */
export async function resolveTools(srv) {
  const override = srv?.a2a?.tools

  // Default path
  if (override === undefined) return generateTools(srv)

  let arr
  if (typeof override === "function") {
    arr = await override({ srv, generateTools })
  } else if (Array.isArray(override)) {
    arr = override
  } else {
    throw new Error(
      `srv.a2a.tools must be an array of LangChain tools or a factory function ({srv, generateTools}) => tools[]. Got: ${typeof override}`,
    )
  }

  if (!Array.isArray(arr)) {
    throw new Error(
      `srv.a2a.tools factory must return an array of LangChain tools. Got: ${typeof arr}`,
    )
  }

  const toolMap = {}
  const tools = []
  for (const t of arr) {
    if (!t || typeof t.invoke !== "function" || typeof t.name !== "string") {
      throw new Error(
        `srv.a2a.tools contains an invalid item: must be a LangChain tool with a "name" string and "invoke" function. Got: ${JSON.stringify(
          { name: t?.name, hasInvoke: typeof t?.invoke === "function" },
        )}`,
      )
    }
    if (toolMap[t.name]) {
      throw new Error(
        `srv.a2a.tools contains duplicate tool name "${t.name}" for service "${srv?.name}". Tool names must be unique.`,
      )
    }
    instrumentTool(t) // idempotent — already-instrumented tools (e.g. from generateTools) are left unchanged
    toolMap[t.name] = t
    tools.push(t)
  }
  return { tools, toolMap }
}
