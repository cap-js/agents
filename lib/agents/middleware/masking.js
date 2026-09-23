import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { randomBytes } from "node:crypto"
import { decode, encode } from "@toon-format/toon"
import { ensureSession, pseudonymize, resolveRemoteMcpTool } from "../../masking/index.js"
import { resolveArgs, needsMasking } from "../../masking/structured/index.js"
import z from "zod"
import { Command, StateSchema, ReducedValue } from "@langchain/langgraph"

// REVISIT: Whether it is possible to make it easier without the ReducedValue class
const stateSchema = new StateSchema({
  seed: new ReducedValue(z.string().default(randomBytes(16).toString("hex")), {
    reducer: (_current, next) => next,
  }),
  hashToOriginal: new ReducedValue(z.map(z.string(), z.string()).default(new Map()), {
    reducer: (_current, next) => next,
  }),
})

export function masking(srv) {
  if (!cds.env.agents?.masking) return null

  return createMiddleware({
    name: "masking",
    stateSchema,

    beforeAgent: async () => {
      if (!needsMasking(srv.name)) return
      await ensureSession()
      cds.context["agent.masking.tools"] = true
    },

    wrapToolCall: async (request, handler) => {
      const session = cds.context?.["agent.pseudonyms"]
      if (!session || !cds.context["agent.masking.tools"]) return handler(request)

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
        // Resolve remote MCP tool prefix before srv.send (cds.context differs inside event)
        const remote = resolveRemoteMcpTool(toolName)
        const effectiveToolName = remote?.bareName ?? toolName

        // Decode TOON or JSON — pseudonymize operates on decoded objects
        const { decoded, format } = decodeContent(toolMessage.content)
        if (decoded) {
          const result = await pseudonymize(
            {
              data: decoded,
              type: toolArgs.cql ? "cql" : "action",
              seed: session._seed,
              metadata: {
                cql: toolArgs.cql,
                toolName: effectiveToolName,
                ...(remote?.remoteSrv && { serviceName: remote.remoteSrv.name }),
              },
            },
            srv,
          )

          session.addMappings(result?.mappings)

          const encoded = format === "toon" ? encode(result.data) : JSON.stringify(result.data)
          if (encoded !== toolMessage.content) {
            const { ToolMessage } = await import("@langchain/core/messages")
            outMessage = new ToolMessage({ ...toolMessage, content: encoded })
          }
        }
      }

      return new Command({
        update: {
          messages: [outMessage],
          seed: session._seed,
          hashToOriginal: session._hashToOriginal,
        },
      })
    },
  })
}

function decodeContent(content) {
  if (typeof content !== "string" || !content) return {}
  try {
    return { decoded: decode(content), format: "toon" }
  } catch {
    try {
      return { decoded: JSON.parse(content), format: "json" }
    } catch {
      return {}
    }
  }
}
