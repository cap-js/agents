import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { randomBytes } from "node:crypto"
import { resolveRemoteMcpTool, ensureSession } from "../../masking/index.js"
import { resolveArgs, pseudonymizeToolResult } from "../../masking/structured/index.js"
import z from "zod"
import { Command } from "@langchain/langgraph"

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

    beforeAgent: async () => {
      await ensureSession(srv.name)
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
