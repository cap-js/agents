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
import { getFilteredEntities, getFilteredActions } from "../../lib/utils/utils.js"
import { isTextMime } from "../../lib/agents/markdown/backends/mime-utils.js"

const LOG = cds.log("agent")

const unwrap = (result) => {
  const text = result.content?.[0]?.text ?? ""
  if (result.isError) throw new Error(text)
  return text
}

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

  const TOOL_PREFIX = ""

  // Query tool — one tool for reading all entities
  const entityNames = Object.keys(entities)
  if (entityNames.length > 0) {
    const def = createGenericReadToolDefinition(entityNames, srv.name, TOOL_PREFIX)
    tools.push(
      new DynamicStructuredTool({
        name: def.name,
        description: def.description,
        schema: def.inputSchema,
        func: async (args) => {
          return unwrap(await executeGenericReadTool(srv, entities, args, { log: LOG }))
        },
      }),
    )
  }

  // Describe tool — introspect service model
  const actionNames = Object.keys(actions)
  if (entityNames.length > 0 || actionNames.length > 0) {
    const def = createDescribeToolDefinition(entityNames, actionNames, srv.name, TOOL_PREFIX)
    tools.push(
      new DynamicStructuredTool({
        name: def.name,
        description: def.description,
        schema: def.inputSchema,
        func: async (args) => {
          return unwrap(await executeDescribe(srv, entities, actions, args, { log: LOG }))
        },
      }),
    )
  }

  // Action/function tools — per-action (default) or combined call action
  const usePerActionTools = cds.env.agents?.per_action_tool !== false
  if (actionNames.length > 0) {
    if (usePerActionTools) {
      for (const [name, action] of Object.entries(actions)) {
        const def = createPerActionToolDefinition(name, action, srv.name, srv.model, TOOL_PREFIX)
        tools.push(
          new DynamicStructuredTool({
            name: def.name,
            description: def.description,
            schema: def.inputSchema,
            func: async (args) => {
              return unwrap(await executePerActionTool(srv, name, action, args, { log: LOG }))
            },
          }),
        )
      }
    } else {
      const def = createCallActionToolDefinition(actionNames, srv.name, TOOL_PREFIX)
      tools.push(
        new DynamicStructuredTool({
          name: def.name,
          description: def.description,
          schema: def.inputSchema,
          func: async (args) => {
            return unwrap(await executeCallActionTool(srv, actions, args, { log: LOG }))
          },
        }),
      )
    }
  }

  // File tools — only when fileIO is enabled
  // emit_file_part: stateless protocol emitter; safe to tools.push once at startup.
  // read_file: per-request (needs contextId) — created on-demand via createReadFileTool().
  if (cds.env.agents?.fileIO?.enabled) {
    tools.push(createEmitFilePartTool())
  }

  return tools
}

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
 * Create a read_file tool scoped to the current conversation.
 * For the default LangGraph path only — deepagents tools.pushs its own read_file
 * tool via FilesystemMiddleware, which routes through UploadsBackend.
 *
 * When contextId is omitted, the tool resolves it from cds.context at invocation
 * time (set by GraphExecutor before graph.invoke). This allows a single tool
 * instance to be reused across requests in createAgent-based graphs.
 *
 * @param {import('../../lib/protocol/persistence/file-store.js').CdsFileStore} fileStore
 * @param {string} [contextId] - If omitted, read from cds.context["agent.context.id"]
 * @param {string} [userId] - If omitted, read from cds.context.user.id
 */
export function createReadFileTool(fileStore, contextId, userId) {
  return tool(
    async ({ path: filePath }) => {
      try {
        const resolvedContextId = contextId || cds.context?.["agent.context.id"]
        const resolvedUserId = userId || cds.context?.user?.id
        const name = filePath.replace(/^\/uploads\//, "")
        if (!fileStore) {
          return `read_file is not available in this context (no file store configured).`
        }
        const file = await fileStore.getInputFile(resolvedContextId, name, resolvedUserId)
        if (!file) {
          const available =
            (await fileStore.listInputFiles(resolvedContextId, resolvedUserId))
              .map((f) => `/uploads/${f.name}`)
              .join(", ") || "none"
          LOG.info("read_file (not found)", {
            contextId: resolvedContextId,
            path: filePath,
            available,
          })
          return `File not found: ${filePath}. Available files: ${available}`
        }
        if (file.mimeType?.startsWith("image/")) {
          LOG.info("read_file (image, not returned as text)", {
            contextId: resolvedContextId,
            path: filePath,
            mimeType: file.mimeType,
            size: file.size,
          })
          return `"${name}" is an image (${formatFileSize(file.size)}). Use an image analysis tool to process it.`
        }
        if (!isTextMime(file.mimeType)) {
          LOG.info("read_file (binary, not returned as text)", {
            contextId: resolvedContextId,
            path: filePath,
            mimeType: file.mimeType,
            size: file.size,
          })
          return `"${name}" is a binary file (${file.mimeType}, ${formatFileSize(file.size)}). Cannot be read as text.`
        }
        LOG.info("read_file", {
          contextId: resolvedContextId,
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
