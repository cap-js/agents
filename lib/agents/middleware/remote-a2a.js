import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { ToolMessage } from "@langchain/core/messages"
import { getTracer } from "../../telemetry/metrics.js"

const LOG = cds.log("agents:a2a|agents|subagents|a2a")

/**
 * Middleware that resolves remote A2A agent cards per-request using the current user's auth headers.
 * Tools are cached on cds.context.__a2aDynamicTools keyed by base URL for the lifetime of the
 * request so multi-turn ReAct loops don't re-fetch the agent card on every model invocation.
 */
export function remoteA2aMiddleware() {
  return createMiddleware({
    name: "RemoteA2aMiddleware",

    wrapModelCall: async (request, handler) => {
      const cache = (cds.context.__a2aDynamicTools ??= {})
      const placeholders = (request.tools ?? []).filter((t) => t._a2aDynamic)
      await Promise.all(
        placeholders.map(async ({ base, serviceName, resolveHeaders }) => {
          if (cache[base]) return

          const headers = await resolveHeaders()
          const cardUrl = `${base}/.well-known/agent-card.json`
          const cardRes = await fetch(cardUrl, { headers: { Accept: "application/json", ...headers } })
          if (!cardRes.ok) {
            throw new Error(
              `[subagents] Agent card fetch failed for "${serviceName}" at ${cardUrl}: HTTP ${cardRes.status}`,
            )
          }
          const agentCard = await cardRes.json()
          LOG.debug(`Fetched agent card for ${serviceName}`, { name: agentCard.name })

          const { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory, RestTransportFactory } =
            await import("@a2a-js/sdk/client")

          const customFetch = async (url, init = {}) => {
            const freshHeaders = await resolveHeaders()
            if (getTracer()) {
              const { context, propagation } = await import("@opentelemetry/api")
              propagation.inject(context.active(), freshHeaders)
            }
            return fetch(url, { ...init, headers: { ...freshHeaders, ...(init.headers || {}) } })
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

          const { createA2ATool } = await import("../../../srv/handlers/subagent-tools.js")
          const toolInstance = createA2ATool(client, agentCard, serviceName)
          cache[base] = { serviceName, tool: toolInstance }
          LOG.info(`Connected to subagent "${agentCard.name}" (${serviceName})`, { at: base })
        }),
      )
      const resolved = placeholders.map(({ base }) => cache[base]?.tool).filter(Boolean)
      const staticTools = (request.tools ?? []).filter((t) => !t._a2aDynamic)
      return handler({ ...request, tools: [...staticTools, ...resolved] })
    },

    wrapToolCall: async (request, handler) => {
      const allCached = Object.values(cds.context.__a2aDynamicTools ?? {}).map((e) => e.tool)
      const tool = allCached.find((t) => t?.name === request.toolCall.name)
      if (!tool) return handler(request)
      try {
        const output = await tool.invoke(request.toolCall.args)
        return new ToolMessage({
          name: request.toolCall.name,
          content: typeof output === "string" ? output : JSON.stringify(output),
          tool_call_id: request.toolCall.id,
        })
      } catch (err) {
        LOG.warn(`A2A subagent tool "${request.toolCall.name}" error: ${err.message}`)
        return new ToolMessage({
          name: request.toolCall.name,
          content: `Error: ${err.message}`,
          tool_call_id: request.toolCall.id,
        })
      }
    },
  })
}
