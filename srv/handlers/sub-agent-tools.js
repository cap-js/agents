import cds from "@sap/cds"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { LangGraphExecutor } from "../langgraph-executor-srv.js"
import { toolName } from "../../lib/utils/utils.js"

const LOG = cds.log("agent:sub-agents")

/**
 * Extract text and file parts from an A2A response (task or message).
 */
function extractResult(result) {
  if (!result) return { text: "No response from agent.", files: [] }

  const text = []
  const files = []

  const processParts = (parts = []) => {
    for (const part of parts) {
      if (part.kind === "text") text.push(part.text)
      else if (part.kind === "file") files.push(part)
    }
  }

  if (result.kind === "task") {
    processParts(result.status?.message?.parts)
    for (const artifact of result.artifacts || []) processParts(artifact.parts)
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

/**
 * Wrap an A2A client as a LangChain tool the agent can call.
 */
function createA2ATool(client, agentCard) {
  return tool(
    async ({ message }) => {
      try {
        const result = await client.sendMessage({
          message: {
            kind: "message",
            role: "user",
            messageId: cds.utils.uuid(),
            parts: [{ kind: "text", text: message }],
          },
        })
        return formatToolResult(extractResult(result))
      } catch (err) {
        LOG.warn("Sub-agent tool error", { agent: agentCard.name, error: err.message })
        return `Error communicating with ${agentCard.name}: ${err.message}`
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
}

export async function buildSubAgentToolLocally(serviceName) {
  const srv = cds.services[serviceName]
  if (!srv) throw new Error(`[sub-agents] No local service "${serviceName}" found.`)

  const executor = LangGraphExecutor.for(srv)

  const { generateAgentCard } = await import("../../lib/protocol/agent-card.js")
  const agentCard = generateAgentCard(srv)
  LOG.info(`Wired local sub-agent "${agentCard.name}" (${serviceName})`)

  const { RequestContext, DefaultExecutionEventBus } = await import("@a2a-js/sdk/server")

  return tool(
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
          if (state === "failed") failed = text || "Sub-agent execution failed."
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
        // Run the sub-agent detached from the calling agent, in its own root
        // context and transaction (cds.spawn creates + commits a fresh tx). A
        // shared transaction breaks the stream.
        await new Promise((resolve, reject) => {
          cds
            .spawn({ user: cds.context?.user, tenant: cds.context?.tenant }, async () => {
              await executor.execute(requestContext, eventBus)
              await done
            })
            .on("succeeded", resolve)
            .on("failed", reject)
        })
      } catch (err) {
        LOG.warn("Local sub-agent tool error", { agent: agentCard.name, error: err.message })
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
}

export async function buildSubAgentToolFromConnection(serviceName) {
  let endpoints = cds.service.endpoints4({
    name: serviceName,
    definition: cds.model.services[serviceName],
  })
  endpoints = Object.fromEntries(endpoints.map((o) => [o.kind, o.path]))
  const { credentials, kind } = cds.requires[serviceName]

  const destinationName = typeof credentials === "string" ? credentials : credentials?.name
  const localUrl =
    typeof credentials === "string"
      ? null
      : kind === undefined
        ? credentials?.url?.replace("undefined", endpoints?.agent)
        : kind !== "agent" && endpoints?.[kind]
          ? credentials?.url.replace(endpoints[kind], endpoints.agent)
          : credentials?.url

  if (!localUrl && !destinationName) {
    throw new Error(
      `[sub-agents] Could not resolve URL or destination name for service "${serviceName}". Check cds.requires config.`,
    )
  }

  const resolveHeaders = destinationName
    ? async () => {
        try {
          const { getDestination, buildHeadersForDestination, retrieveJwt } =
            await import("@sap-cloud-sdk/connectivity")
          const jwt = retrieveJwt(cds.context?.http?.req)
          const resolvedDest = await getDestination({ destinationName, jwt })
          const rawHeaders = await buildHeadersForDestination(resolvedDest)
          return Object.fromEntries(
            Object.entries(rawHeaders).map(([k, v]) => [
              k.replace(/(^|-)(.)/g, (_, sep, c) => sep + c.toUpperCase()),
              v,
            ]),
          )
        } catch (err) {
          LOG.warn(
            `Could not resolve destination "${destinationName}" via Cloud SDK, falling back: ${err.message}`,
          )
          const token = typeof credentials === "object" ? credentials?.authTokens?.[0]?.value : null
          return token ? { Authorization: `Bearer ${token}` } : {}
        }
      }
    : async () => {
        const token = credentials?.authTokens?.[0]?.value
        return token ? { Authorization: `Bearer ${token}` } : {}
      }

  // Resolve URL once at build time; headers are resolved fresh on every request.
  let agentBaseUrl = localUrl
  if (destinationName) {
    try {
      const { getDestination, retrieveJwt } = await import("@sap-cloud-sdk/connectivity")
      const jwt = retrieveJwt(cds.context?.http?.req)
      const resolvedDest = await getDestination({ destinationName, jwt })
      if (resolvedDest?.url) agentBaseUrl = resolvedDest.url
    } catch (err) {
      LOG.warn(
        `Could not resolve destination URL for "${destinationName}", using localUrl: ${err.message}`,
      )
    }
  }

  if (!agentBaseUrl) {
    throw new Error(
      `[sub-agents] Could not resolve URL for service "${serviceName}" after destination lookup.`,
    )
  }

  const base = agentBaseUrl.replace(/\/$/, "")
  LOG.info(`Connecting to sub-agent at ${base}`)

  // revisit: a2a agents may be tenant specific, card per tenant?
  const initialHeaders = await resolveHeaders()
  const cardUrl = `${base}/.well-known/agent-card.json`
  const cardRes = await fetch(cardUrl, {
    headers: { Accept: "application/json", ...initialHeaders },
  })
  if (!cardRes.ok) {
    throw new Error(
      `[sub-agents] Agent card fetch failed for "${serviceName}" at ${cardUrl}: HTTP ${cardRes.status}`,
    )
  }
  const agentCard = await cardRes.json()
  LOG.info(`Connected to sub-agent "${agentCard.name}" (${serviceName})`)

  const { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory, RestTransportFactory } =
    await import("@a2a-js/sdk/client")

  const customFetch = async (url, init = {}) => {
    const headers = await resolveHeaders()
    return fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } })
  }
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: customFetch }),
        new RestTransportFactory({ fetchImpl: customFetch }),
      ],
    }),
  )
  const client = await factory.createFromAgentCard(agentCard)

  return createA2ATool(client, agentCard)
}

export function buildSubAgentTool(serviceName) {
  return cds.requires[serviceName]?.credentials
    ? buildSubAgentToolFromConnection(serviceName)
    : buildSubAgentToolLocally(serviceName)
}
