import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { PseudoSession } from "../../pseudonymize/store.js"
import {
  hasPersonalDataAnnotations,
  resolveArgs,
  pseudonymizationThreadId,
  pseudonymizeToolResult,
} from "../../pseudonymize/structured/index.js"
import { toolName as normaliseName } from "../../utils/utils.js"

function threadIdFromContext() {
  return pseudonymizationThreadId(cds.context?.["agent.service"], cds.context?.["agent.context.id"])
}

// For a remote MCP tool name like "catalogservice_query", strip the service prefix
// and return { bareName, remoteSrv }.  Returns null for local tools.
function resolveRemoteMcpTool(prefixedName) {
  const cache = cds.context?.__mcpDynamicTools
  if (!cache) return null
  for (const { serviceName, tools } of Object.values(cache)) {
    const prefix = normaliseName(`${serviceName}_`)
    if (!prefixedName.startsWith(prefix)) continue
    if (!tools?.some((t) => t.name === prefixedName)) continue
    return { bareName: prefixedName.slice(prefix.length), remoteSrv: cds.services?.[serviceName] }
  }
  return null
}

export function pseudonymizeMiddleware(srv) {
  if (!cds.env.agents?.masking) return null

  return createMiddleware({
    name: "pseudonymize",

    // Once per run: gate on annotations, load session, stash it on cds.context.
    beforeAgent: async () => {
      const model = cds.context?.model ?? srv.model
      if (!hasPersonalDataAnnotations(model, srv.name)) return
      const session = await PseudoSession.loadOrCreate(threadIdFromContext())
      if (session) cds.context._pseudoSession = session
    },

    wrapToolCall: async (request, handler) => {
      const session = cds.context?._pseudoSession
      if (!session) return handler(request)

      const toolName = request.toolCall?.name
      const toolArgs = request.toolCall?.args ?? {}
      const resolvedArgs = resolveArgs(toolArgs, session)
      const resolvedRequest =
        resolvedArgs !== toolArgs
          ? { ...request, toolCall: { ...request.toolCall, args: resolvedArgs } }
          : request

      const toolMessage = await handler(resolvedRequest)

      let outMessage = toolMessage
      if (toolMessage?.content) {
        // For remote MCP tools strip the service prefix to get the bare tool name,
        // and switch to the remote service's model when it is available locally.
        const remote = resolveRemoteMcpTool(toolName)
        const effectiveToolName = remote?.bareName ?? toolName
        const effectiveSrv = remote?.remoteSrv

        const content = await pseudonymizeToolResult({
          content: toolMessage.content,
          toolName: effectiveToolName,
          cql: toolArgs.cql,
          ...(effectiveSrv && {
            srv: effectiveSrv,
            model: cds.context?.model ?? effectiveSrv.model,
          }),
        })
        if (content !== toolMessage.content) {
          const { ToolMessage } = await import("@langchain/core/messages")
          outMessage = new ToolMessage({ ...toolMessage, content })
        }
      }

      return outMessage
    },
  })
}
