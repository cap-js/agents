import cds from "@sap/cds"
import { DynamicStructuredTool, tool } from "@langchain/core/tools"
import z from "zod"
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
import { getFilteredEntities, getFilteredActions, audit } from "../../lib/utils/utils.js"
import { isTextMime } from "../../lib/agents/markdown/backends/mime-utils.js"
import * as metrics from "../../lib/telemetry/metrics.js"
import { INSTRUMENTED } from "../../lib/telemetry/tracing.js"
import { mlflowAttrs, setSpanAttrs } from "../../lib/telemetry/mlflow.js"

const LOG = cds.log("agent")

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
    if (authResult.error) return []
    entities = authResult.entities
    actions = authResult.actions
  }

  const tools = []

  function register(dstool) {
    // Wrap invoke to catch errors (become normal tool results the LLM can learn from)
    // and to create OTel spans + record metrics for each tool invocation.
    const originalInvoke = dstool.invoke.bind(dstool)
    dstool.invoke = async (args, config) => {
      const tracer = metrics.getTracer()
      const toolAttrs = {
        "sap.tenantId": cds.context?.tenant || "anonymous",
        "agent.service": cds.context?.["agent.service"],
        tool: dstool.name,
      }

      const invoke = async (span) => {
        if (span) {
          span.setAttribute("gen_ai.operation.name", "execute_tool")
          span.setAttribute("gen_ai.provider.name", "langchain")
          span.setAttribute("agent.span.kind", "tool")
          span.setAttribute("agent.tool.name", dstool.name)
          if (LOG._debug) {
            const input = JSON.stringify(args)
            span.setAttribute("agent.entity.input", input)
          }
        }
        const t0 = Date.now()
        try {
          const result = await originalInvoke(args, config)
          const duration = Date.now() - t0
          metrics.toolInvocations.add(1, { ...toolAttrs, outcome: "success" })
          if (span) {
            span.setAttribute("agent.tool.outcome", "success")
            if (LOG._debug) {
              const output = typeof result === "string" ? result : JSON.stringify(result)
              span.setAttribute("agent.entity.output", output)
            }
            setSpanAttrs(
              span,
              mlflowAttrs("TOOL", { inputs: args, outputs: result, functionName: dstool.name }),
            )
          }

          // Audit: record tool invocation
          const taskId = config?.configurable?._taskId || cds.context?.["agent.task.id"]
          if (taskId) {
            const resultStr = typeof result === "string" ? result : JSON.stringify(result)
            audit("ToolInvocation", {
              data: {
                taskId,
                service: config?.configurable?._service || cds.context?.["agent.service"],
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
            span.setAttribute("agent.tool.outcome", "error")
            span.setStatus({ code: 2, message: err.message })
          }

          // Audit: record failed tool invocation
          const taskId = config?.configurable?._taskId || cds.context?.["agent.task.id"]
          if (taskId) {
            audit("ToolInvocation", {
              data: {
                taskId,
                service: config?.configurable?._service || cds.context?.["agent.service"],
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
          const result = await executeGenericReadTool(srv, entities, args, { log: LOG })
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
          const result = await executeDescribe(srv, entities, actions, args, { log: LOG })
          return result.content[0].text
        },
      }),
    )
  }

  // Action/function tools — per-action (default) or combined call_action
  const usePerActionTools = cds.env.agents?.per_action_tool !== false
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
              const result = await executePerActionTool(srv, name, action, args, { log: LOG })
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
            const result = await executeCallActionTool(srv, actions, args, { log: LOG })
            return result.content[0].text
          },
        }),
      )
    }
  }

  // File tools — only when fileIO is enabled
  // emit_file_part: stateless protocol emitter; safe to register once at startup.
  // read_file: per-request (needs contextId) — created on-demand via createReadFileTool().
  if (cds.env.agents?.fileIO?.enabled) {
    register(createEmitFilePartTool())
  }

  return tools
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
function _instrumentTool(t) {
  if (t[INSTRUMENTED]) return t
  const originalInvoke = t.invoke.bind(t)

  t.invoke = async (args, config) => {
    const tracer = metrics.getTracer()
    const toolAttrs = {
      "sap.tenantId": cds.context?.tenant || "anonymous",
      "agent.service": config?.configurable?._service || cds.context?.["agent.service"],
      tool: t.name,
    }

    const invoke = async (span) => {
      if (span) {
        span.setAttribute("gen_ai.operation.name", "execute_tool")
        span.setAttribute("gen_ai.provider.name", "langchain")
        span.setAttribute("agent.span.kind", "tool")
        span.setAttribute("agent.tool.name", t.name)
        if (LOG._debug) span.setAttribute("agent.entity.input", JSON.stringify(args))
      }
      const t0 = Date.now()
      try {
        const result = await originalInvoke(args, config)
        const duration = Date.now() - t0
        metrics.toolInvocations.add(1, { ...toolAttrs, outcome: "success" })
        if (span) {
          span.setAttribute("agent.tool.outcome", "success")
          if (LOG._debug) {
            const output = typeof result === "string" ? result : JSON.stringify(result)
            span.setAttribute("agent.entity.output", output)
          }
        }

        // Audit: record tool invocation
        const taskId = config?.configurable?._taskId || cds.context?.["agent.task.id"]
        if (taskId) {
          const resultStr = typeof result === "string" ? result : JSON.stringify(result)
          audit("ToolInvocation", {
            data: {
              taskId,
              service: toolAttrs["agent.service"],
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
          span.setAttribute("agent.tool.outcome", "error")
          span.setStatus({ code: 2, message: err.message })
        }

        // Audit: record failed tool invocation
        const taskId = config?.configurable?._taskId || cds.context?.["agent.task.id"]
        if (taskId) {
          audit("ToolInvocation", {
            data: {
              taskId,
              service: toolAttrs["agent.service"],
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
 * Instrument tool instances for tracing, audit logging, and metrics.
 *
 * Use this for custom tools (created via `tool()`) or MCP tools whose `.invoke`
 * is overridden on the instance — cases where the prototype-level patch alone
 * cannot intercept the call.
 *
 * Idempotent: tools already instrumented by `@cap-js/agents` are returned untouched.
 *
 * Unlike CDS tools (which swallow errors so the LLM can retry), this re-throws
 * errors after recording them. Wrap with a try/catch if you need error swallowing.
 *
 * @param {import("@langchain/core/tools").StructuredTool[]} tools - Tools to instrument
 * @returns {import("@langchain/core/tools").StructuredTool[]} The same tools (mutated)
 */
export function instrumentTools(tools) {
  tools.forEach(_instrumentTool)
  return tools
}
/**
 * Instrument a single tool. Re-exported as a thin alias over the internal
 * `_instrumentTool` so prior consumers of `instrumentTool` (singular) keep
 * working — destructured ES imports of an undefined export fail silently.
 *
 * @param {import("@langchain/core/tools").StructuredTool} t
 * @returns {import("@langchain/core/tools").StructuredTool}
 */
export const instrumentTool = _instrumentTool

// ── File tools ────────────────────────────────────────────────────────

/**
 * Render a byte count as a human-readable string ("123 B" / "12.3 KB" / "1.2 MB").
 * Exported so callers (e.g. GraphExecutor's file manifest) format sizes identically.
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Sanitize a user-supplied filename so it is safe to use as a stable key,
 * a /uploads/<name> path component, and an artifactId fragment.
 *
 * - Strips any directory components (path.basename) — defeats `../../etc/passwd`
 *   tricks that would otherwise produce confusing artifactIds and DB keys.
 * - Replaces characters that are not letters, digits, dot, dash, underscore, or
 *   space with `_`. Leaves Unicode letters (CJK/etc.) intact.
 * - Collapses leading dots so the name cannot start with `.` (avoids hidden-file
 *   surprises and `..` artifacts).
 * - Falls back to "unnamed" for empty input.
 */
export function sanitizeFilename(raw) {
  const name = String(raw ?? "").trim()
  if (!name) return "unnamed"
  // path.basename equivalent without pulling in node:path: drop everything up to
  // the last forward- or back-slash. Also drop any pure ".."/"." segments.
  const base = name.replace(/^.*[\\/]/, "")
  const cleaned = base.replace(/[^\p{L}\p{N}._\-\s]/gu, "_").replace(/^\.+/, "")
  return cleaned || "unnamed"
}

/**
 * Create a tool that emits a file as part of the A2A response.
 * Pure protocol emitter — caller provides the bytes, no generation, no placeholders.
 * The executor's toolResults collection loop parses `kind:'file'` JSON from this tool.
 */
export function createEmitFilePartTool() {
  return tool(
    async ({ filename, mimeType, content, encoding = "utf-8" }) => {
      const bytes =
        encoding === "base64" ? content : Buffer.from(content, "utf-8").toString("base64")
      const decodedSize =
        encoding === "base64"
          ? Buffer.byteLength(content, "base64")
          : Buffer.byteLength(content, "utf-8")
      LOG.info("emit_file_part", { filename, mimeType, encoding, bytes: decodedSize })
      return JSON.stringify({ kind: "file", file: { name: filename, mimeType, bytes } })
    },
    {
      name: "emit_file_part",
      description:
        'Emit a file as part of the A2A response. For text formats (CSV, JSON, plain text) provide raw text content. For binary formats provide base64-encoded content and set encoding to "base64". You are responsible for obtaining or generating the file content before calling this tool.',
      schema: z.object({
        filename: z.string().describe("Filename with extension, e.g. report.csv"),
        mimeType: z.string().describe("MIME type, e.g. text/csv, application/json, image/png"),
        content: z
          .string()
          .describe("File content: raw text for text formats, base64 string for binary formats"),
        encoding: z.enum(["utf-8", "base64"]).optional().default("utf-8"),
      }),
    },
  )
}

/**
 * Create a read_file tool scoped to the given conversation.
 * For the default LangGraph path only — deepagents registers its own read_file
 * tool via FilesystemMiddleware, which routes through UploadsBackend.
 *
 * Created per-request because contextId is request-scoped. The userId is
 * captured at request entry (cds.context can be lost mid-graph across
 * AsyncLocalStorage boundaries) and threaded through to the file store.
 *
 * @param {import('../../lib/protocol/persistence/file-store.js').CdsFileStore} fileStore
 * @param {string} contextId
 * @param {string} [userId] - Captured at request entry; falls back to cds.context inside the store.
 */
export function createReadFileTool(fileStore, contextId, userId) {
  return tool(
    async ({ path: filePath }) => {
      try {
        const name = filePath.replace(/^\/uploads\//, "")
        if (!fileStore) {
          return `read_file is not available in this context (no file store configured).`
        }
        const file = await fileStore.getInputFile(contextId, name, userId)
        if (!file) {
          const available =
            (await fileStore.listInputFiles(contextId, userId))
              .map((f) => `/uploads/${f.name}`)
              .join(", ") || "none"
          LOG.info("read_file (not found)", { contextId, path: filePath, available })
          return `File not found: ${filePath}. Available files: ${available}`
        }
        if (file.mimeType?.startsWith("image/")) {
          LOG.info("read_file (image, not returned as text)", {
            contextId,
            path: filePath,
            mimeType: file.mimeType,
            size: file.size,
          })
          return `"${name}" is an image (${formatFileSize(file.size)}). Use an image analysis tool to process it.`
        }
        if (!isTextMime(file.mimeType)) {
          LOG.info("read_file (binary, not returned as text)", {
            contextId,
            path: filePath,
            mimeType: file.mimeType,
            size: file.size,
          })
          return `"${name}" is a binary file (${file.mimeType}, ${formatFileSize(file.size)}). Cannot be read as text.`
        }
        LOG.info("read_file", {
          contextId,
          path: filePath,
          mimeType: file.mimeType,
          size: file.size,
        })
        return file.bytes.toString("utf-8")
      } catch (err) {
        LOG.error("read_file failed", { filePath, error: err.message })
        return `Error reading file: ${err.message}`
      }
    },
    {
      name: "read_file",
      description:
        "Read the contents of an uploaded file. Use the /uploads/<filename> path from the file manifest. Returns file content for text-based formats.",
      schema: z.object({
        path: z.string().describe("File path, e.g. /uploads/report.csv"),
      }),
    },
  )
}
