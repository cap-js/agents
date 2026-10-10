import cds from '@sap/cds'
import { Agent } from '@earendil-works/pi-agent-core'

export default async function create(srv) {
  const tools = await srv.send('buildTools', { harness: 'pi' })
  const llm = await srv.send('buildModel', { harness: 'pi' })
  const systemPrompt = await srv.send('buildSystemPrompt')
  if (!llm?.model || typeof llm.streamFn !== 'function') {
    throw new Error(
      'Pi models must expose a model and streamFn; configure a Pi model kind such as pi-anthropic',
    )
  }

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
      initializeHistory(agent)
      return agent
    }
  }
}

// ===== Session Persistence ======
export async function initializeHistory(agent) {
  const key = piSessionKey()
  const store = getStore()
  const messages = await store.load(key)

  if (messages) agent.state.messages = messages
  agent.subscribe(async (event) => {
    if (event.type === 'agent_end') {
      await store.save(key, agent.state.messages)
    }
  })
}

/**
 * In-memory Pi session store. Messages are lost when the process restarts.
 */
export class InMemoryPiSessionStore {
  _sessions = new Map()

  async load(key) {
    return this._sessions.get(key) ?? []
  }

  async save(key, messages) {
    this._sessions.set(key, messages)
  }

  async delete(key) {
    this._sessions.delete(key)
  }
}


let _store
export function getStore() {
  if (_store) return _store
  return _store = new InMemoryPiSessionStore()
}


/** Compute the session key for a given CDS context, service, and contextId. */
export function piSessionKey(srv, contextId) {
  const tenant = cds.context?.tenant || 'anonymous'
  const userId = cds.context?.user?.id || 'anonymous'
  contextId ??= cds.context?.['agent.context.id']
  const srvName = cds.context?.['agent.service'] ?? srv?.name
  return `${tenant}:${userId}:${srvName}:${contextId}`
}
