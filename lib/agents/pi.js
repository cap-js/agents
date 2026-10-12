import cds from '@sap/cds'
import { Agent } from '@earendil-works/pi-agent-core'

export default async function create(srv) {
  const tools = await srv.send('buildTools', { harness: 'pi' })
  const llm = await srv.send('buildModel', { harness: 'pi' })
  const systemPrompt = await srv.send('buildSystemPrompt')

  return {
    harness: 'pi',
    factory: async () => {
      const agent = new Agent({
        initialState: {
          systemPrompt,
          model: llm.model,
          tools,
        },
        streamFn: llm.streamFn,
        getApiKey: llm.getApiKey,
      })
      initializeHistory(agent, srv)
      return agent
    }
  }
}

// ===== In-Memory Session Persistence ======
let _store
function initializeHistory(agent, srv) {
  const key = piSessionKey(srv)
  const store = (_store ??= {})
  const messages = store[key]

  if (messages) agent.state.messages = messages
  agent.subscribe(event => {
    if (event.type === 'agent_end') {
      store[key] = agent.state.messages
    }
  })
}

/** Compute the session key for a given CDS context, service, and contextId. */
function piSessionKey(srv) {
  const tenant = cds.context?.tenant || 'unknown'
  const userId = cds.context?.user?.id || 'anonymous'
  const contextId = cds.context?.['agent.context.id']
  return `${tenant}:${userId}:${srv.name}:${contextId}`
}
