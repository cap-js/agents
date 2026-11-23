import cds from "@sap/cds"
import { inspect } from "util"
import { a2aClient } from "../../lib/remote/a2a.js"
import { outboundConnection } from "../../lib/remote/http.js"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { LangGraphExecutor } from "../langgraph-executor-srv.js"
import { short, toolName } from "../../lib/utils/utils.js"

const LOG = cds.log("agents:a2a|agents|subagents|a2a")

const TRUNCATE = cds.env.agents?.truncate || 111
const truncated = (msg) => (msg?.length > TRUNCATE ? msg.slice(0, TRUNCATE) + "..." : msg)

export function buildSubAgentTool(serviceName) {
  return cds.requires[serviceName]?.credentials
    ? buildSubAgentToolFromConnection(serviceName)
    : buildSubAgentToolLocally(serviceName)
}

export async function buildSubAgentToolFromConnection(serviceName) {
  const connection = outboundConnection(serviceName, "agent")

  return {
    serviceName,
    _dynamicTools: async () => {
      const { client, agentCard } = await a2aClient(connection, serviceName)
      const toolInstance = createA2ATool(client, agentCard, serviceName)
      return [toolInstance]
    },
  }
}

export async function buildSubAgentToolLocally(serviceName) {
  const srv = cds.services[serviceName]
  if (!srv) throw new Error(`[subagents] No local service "${serviceName}" found.`)

  const executor = LangGraphExecutor.for(srv)

  const { compileAgentCard } = await import("../../lib/protocol/agent-card.js")
  const agentCard = compileAgentCard(srv.definition)
  LOG.info(`Connecting to subagent ${serviceName}`, "(local)")

  const { RequestContext, DefaultExecutionEventBus } = await import("@a2a-js/sdk/server")

  const localTool = tool(
    async ({ message }) => {
      const taskId = cds.utils.uuid()
      const contextId = cds.utils.uuid()

      // Drive the local executor directly (no HTTP). Collect published events
      // into a synthetic task so we can reuse extractResult for text + files.
      const eventBus = new DefaultExecutionEventBus()

      // The terminal status message and the "response" text artifact carry the
      // final answer; file-* artifacts carry downstream FileParts. Accumulate
      // the latest of each so partial/streamed updates are superseded.
      let statusText = null
      let responseText = null
      let failed = null
      const files = []

      eventBus.on("event", (event) => {
        if (event.kind === "status-update") {
          const state = event.status?.state
          const text = event.status?.message?.parts
            ?.filter((p) => p.kind === "text")
            .map((p) => p.text)
            .join("\n")
          if (text) statusText = text
          if (state === "failed") failed = text || "Subagent execution failed."
        } else if (event.kind === "artifact-update") {
          const parts = event.artifact?.parts || []
          if (event.artifact?.artifactId === "response") {
            // append:false replaces; append:true accumulates streamed tokens.
            const text = parts
              .filter((p) => p.kind === "text")
              .map((p) => p.text)
              .join("")
            if (text) responseText = event.append ? (responseText || "") + text : text
          }
          for (const p of parts) if (p.kind === "file") files.push(p)
        }
      })

      const done = new Promise((resolve) => eventBus.once("finished", resolve))

      const requestContext = new RequestContext(
        {
          kind: "message",
          role: "user",
          messageId: cds.utils.uuid(),
          taskId,
          contextId,
          parts: [{ kind: "text", text: message }],
        },
        taskId,
        contextId,
      )

      try {
        // Run the subagent detached from the calling agent, in its own root
        // context and transaction (cds.spawn creates + commits a fresh tx). A
        // shared transaction breaks the stream.
        await new Promise((resolve, reject) => {
          cds
            .spawn({ user: cds.context?.user, tenant: cds.context?.tenant }, async () => {
              LOG.info(srv.name, "-", "request", {
                conversation: short(contextId),
                text: truncated(message),
              })

              await executor.execute(requestContext, eventBus)
              await done
            })
            .on("succeeded", resolve)
            .on("failed", reject)
        })
      } catch (err) {
        LOG.warn("Local subagent tool error", { agent: agentCard.name, error: err.message })
        return `Error running ${agentCard.name}: ${err.message}`
      }

      if (failed) return `Error running ${agentCard.name}: ${failed}`

      const text = responseText || statusText || "No response."
      return formatToolResult({ text, files })
    },
    {
      name: toolName(agentCard.name),
      description: toolDescription(agentCard),
      schema: z.object({
        message: z.string().describe("The request to send to this agent"),
      }),
    },
  )
  localTool.metadata = {
    ...localTool.metadata,
    kind: "agent",
    agentName: agentCard.name,
    serviceName,
  }
  return localTool
}

export function createA2ATool(client, agentCard, serviceName) {
  const subagent = agentCard.name
  const t = tool(
    async ({ message }) => {
      try {
        const messageId = cds.utils.uuid()
        LOG.info(`Sending message to ${subagent}`, { messageId }, "\n\n" + message + "\n")
        const result = await client.sendMessage({
          message: {
            kind: "message",
            role: "user",
            messageId,
            parts: [{ kind: "text", text: message }],
          },
        })
        if (LOG._debug)
          LOG.trace(`Raw results from ${subagent}`, inspect(result, { depth: null, colors: true }))
        let response = formatToolResult(extractResult(result))
        if (response)
          LOG.info(
            `Got response from ${subagent}`,
            { messageId },
            "\n\n" + truncated(response) + "\n",
          )
        return response
      } catch (err) {
        LOG.warn("Subagent tool error", { subagent, error: err.message })
        return `Error communicating with ${subagent}: ${err.message}`
      }
    },
    {
      name: toolName(agentCard.name),
      description: toolDescription(agentCard),
      schema: z.object({
        message: z.string().describe("The request to send to this agent"),
      }),
    },
  )
  t.metadata = { ...t.metadata, kind: "agent", agentName: agentCard.name, serviceName }
  return t
}

/**
 * Extract text and file parts from an A2A response (task or message).
 */
function extractResult(result) {
  if (!result) return { text: "No response from agent.", files: [] }

  const text = []
  const files = []

  const processParts = (parts) => {
    for (const part of parts) {
      if (part.kind === "text") text.push(part.text)
      else if (part.kind === "file") files.push(part)
    }
  }

  if (result.kind === "task") {
    if (result.artifacts)
      for (let artifact of result.artifacts) {
        if (!artifact.artifactId.startsWith("thinking")) processParts(artifact.parts)
      }
    else if (result.status?.message) processParts(result.status.message.parts)
    if (text.length === 0 && files.length === 0) {
      return { text: `Task ${result.id}: ${result.status?.state || "unknown"}`, files: [] }
    }
  } else if (result.kind === "message") {
    processParts(result.parts)
  } else {
    return { text: JSON.stringify(result), files: [] }
  }

  return { text: text.join("\n") || "No response.", files }
}

/**
 * Build the tool description from an agent card (or agent-card-like object).
 */
function toolDescription(card) {
  const skills = card.skills?.map((s) => `- ${s.name}: ${s.description}`).join("\n") || ""
  return (
    `Delegate to the "${card.name}" agent. ${card.description || ""}` +
    (skills ? `\n\nSkills:\n${skills}` : "")
  )
}

/**
 * Format an extracted { text, files } pair into the string a tool returns.
 *
 * FileParts are serialized inline as {"kind":"file",...} JSON so the executor's
 * file-collection loop (graph-executor.js) picks them up and re-publishes them
 * as A2A artifacts, plus a human-readable manifest note for the model.
 */
function formatToolResult({ text, files }) {
  if (!files || files.length === 0) return text
  const fileJson = files.map((f) => JSON.stringify({ kind: "file", file: f.file })).join("\n")
  const manifest = files
    .filter((f) => f.file?.bytes)
    .map((f) => `/uploads/${f.file.name} (${f.file.mimeType})`)
  const manifestNote = manifest.length
    ? `\n[Files from downstream agent: ${manifest.join(", ")}]`
    : ""
  return `${text}${manifestNote}\n${fileJson}`
}
