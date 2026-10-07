import cds from '@sap/cds'
import { Agent } from '@earendil-works/pi-agent-core'

const LOG = cds.log('agents')

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
      const contextId = cds.context?.['agent.context.id']
      const key = piSessionKey(srv, contextId)
      const store = getStore('db')
      const messages = await store.load(key)

      const agent = new Agent({
        initialState: {
          systemPrompt,
          model: llm.model,
          tools,
          messages,
        },
        streamFn: llm.streamFn,
        getApiKey: llm.getApiKey,
      })

      agent.subscribe(async (event) => {
        if (event.type === 'agent_end') {
          await store.save(key, agent.state.messages)
        }
      })

      return agent
    }
  }
}

// ===== Session Persistence ======
export async function initializeHistory(agent) {
  const key = piSessionKey()
  const store = getStore('db')
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


const PI_MESSAGES = 'cap.agent.PiMessages'

/**
 * CDS-entity-backed Pi session store. Persists each message as its own row in
 * cap.agent.PiMessages so conversations survive process restarts without the
 * O(n²) growth of rewriting the full history blob on every turn.
 *
 * Requires the PiMessages entity to be present in the model — see entities.cds.
 */
export class CdsPiSessionStore {
  async load(key) {
    try {
      const rows = await SELECT.from(PI_MESSAGES)
        .where({ sessionKey: key })
        .orderBy('seq')
      return rows.map((r) => JSON.parse(r.message))
    } catch (err) {
      LOG.warn('Pi session load failed', { key, error: err.message })
    }
    return []
  }

  async save(key, messages) {
    try {
      const existing = await SELECT.from(PI_MESSAGES).where({ sessionKey: key }).columns('seq')
      const existingCount = existing.length
      const newMessages = messages.slice(existingCount)
      if (newMessages.length === 0) return
      const rows = newMessages.map((msg, i) => ({
        sessionKey: key,
        seq: existingCount + i,
        message: JSON.stringify(msg),
      }))
      await INSERT.into(PI_MESSAGES).entries(rows)
    } catch (err) {
      LOG.warn('Pi session save failed', { key, error: err.message })
    }
  }

  async delete(key) {
    try {
      await DELETE.from(PI_MESSAGES).where({ sessionKey: key })
    } catch (err) {
      LOG.warn('Pi session delete failed', { key, error: err.message })
    }
  }
}


let _store
/**
 * Resolves the active Pi session store from CDS configuration.
 *
 * cds.env.agents.piSessionStore:
 *   'memory'  → InMemoryPiSessionStore  (default)
 *   'db'      → CdsPiSessionStore
 *
 * @returns {PiSessionStore}
 */
export function getStore(kind = 'memory') {
  if (_store) return _store
  if (kind === 'db') return _store = new CdsPiSessionStore()
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
