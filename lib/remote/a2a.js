import cds from "@sap/cds"

const LOG = cds.log("agents:a2a|agents|subagents|a2a")

/** Discover the remote agent and connect its advertised transport in the caller's CDS context. */
export async function a2aClient(connection, serviceName) {
  const { url: base, fetch: customFetch } = await connection.resolve()
  const cardUrl = new URL(base)
  cardUrl.pathname = cardUrl.pathname.replace(/\/$/, "") + "/.well-known/agent-card.json"
  const cardRes = await customFetch(cardUrl, { headers: { Accept: "application/json" } })
  if (!cardRes.ok) {
    await cardRes.body?.cancel()
    throw new Error(
      `[subagents] Agent card fetch failed for "${serviceName}" at ${cardUrl}: HTTP ${cardRes.status}`,
    )
  }
  const agentCard = await cardRes.json()
  LOG.debug(`Fetched agent card for ${serviceName}`, { name: agentCard.name })

  const { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory, RestTransportFactory } =
    await import("@a2a-js/sdk/client")

  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: customFetch }),
        new RestTransportFactory({ fetchImpl: customFetch }),
      ],
    }),
  )
  const client = await factory.createFromAgentCard(agentCard)
  LOG.info(`Connected to subagent "${agentCard.name}" (${serviceName})`, { at: base })
  return { client, agentCard }
}
