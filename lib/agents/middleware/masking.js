import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { randomBytes } from "node:crypto"
import { PseudonymStore } from "../../masking/store.js"
import {
  hasPersonalDataAnnotations,
  resolveArgs,
  pseudonymizeToolResult,
} from "../../masking/structured/index.js"
import { toolName as normaliseName } from "../../utils/utils.js"
import z from "zod"
import { Command } from "@langchain/langgraph"

// For a remote MCP tool name like "catalogservice_query", strip the service prefix
// and return { bareName, remoteSrv }.  Returns null for local tools.
export function resolveRemoteMcpTool(prefixedName) {
  const cache = cds.context?.__mcpDynamicTools
  if (!cache) return null
  for (const { serviceName, tools } of Object.values(cache)) {
    const prefix = normaliseName(`${serviceName}_`)
    if (!tools?.some((t) => t.name === prefixedName)) continue
    // If multiple CAP MCPs are included its possible that one of the CAP MCPs owns query if the agent itself does not expose any entities
    return { bareName: prefixedName.startsWith(prefix) ? prefixedName.slice(prefix.length) : prefixedName, remoteSrv: cds.services?.[serviceName] }
  }
  return null
}

const stateSchema = z.object({
  seed: z.string().default(randomBytes(16).toString("hex")),
  hashToOriginal: z.map(z.string(), z.string()).default(new Map()),
  // HANA NLP text analysis results accumulated across turns for query-time resolution.
  textAnalysisResults: z.array(z.any()).default([]),
})

export default function maskingMiddleware(srv) {
  if (!cds.env.agents?.masking) return null

  return createMiddleware({
    name: "masking",
    stateSchema,

    // Once per run: gate on annotations, load session, stash it on cds.context.
    beforeAgent: async (state) => {
      const model = cds.context?.model ?? srv.model
      let needsMasking = hasPersonalDataAnnotations(model, srv.name)
      if (!needsMasking) {
        // Check each remote MCP service's model for PII annotations
        for (const { serviceName } of Object.values(cds.context?.__mcpDynamicTools ?? {})) {
          const remoteSrv = cds.services?.[serviceName]
          const remoteModel = remoteSrv?.model
          if (remoteModel && hasPersonalDataAnnotations(remoteModel, serviceName)) {
            needsMasking = true
            break
          }
        }
        if (!needsMasking) return
      }
      const { seed, hashToOriginal, textAnalysisResults } = state
      const session = new PseudonymStore(seed, hashToOriginal)
      // Restore HANA NLP results from previous turns so anonymizeUserMessage can append.
      if (textAnalysisResults?.length) session._textAnalysisResults = textAnalysisResults
      cds.context["agent.pseudonyms"] = session
    },

    wrapToolCall: async (request, handler) => {
      const session = cds.context?.["agent.pseudonyms"]
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

        const content = pseudonymizeToolResult({
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

      return new Command({
        update: {
          messages: [outMessage],
          seed: session._seed,
          hashToOriginal: session._hashToOriginal,
          textAnalysisResults: session._textAnalysisResults ?? [],
        },
      })
    },
  })
}
