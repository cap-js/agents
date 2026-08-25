import { Duplex } from 'node:stream'
import cds from '@sap/cds'

const { readFile, opendir } = cds.utils.fs.promises

const LOG = cds.log('agents')

export class AgentSession extends Duplex {
  constructor(srv, options) {
    super({ objectMode: true })
    this.srv = srv
    this.options = options || {}
    this.ID = this.options.ID ?? cds.utils.uuid()
    this._waiting = Promise.withResolvers()
    this._reading = false
  }

  async _read() {
    if (this._reading) return
    this._reading = true

    await this._waiting.promise
    this._waiting = Promise.withResolvers()
    try {
      const llm = await this._llm()
      for await (const chunk of await llm.send({ data: this.loadSession(), iterator: true }))
        this.push({ ...chunk, session: this.ID })
    } catch (err) {
      this.emit('error', err)
    } finally {
      this.push({ role: 'flush' })
      this._reading = false
      this.pause()
    }
  }

  async _write(message, _enc, callback) {
    try {
      const { Messages } = cds.model.entities('cap.agent')
      message = this._row(message)
      if (message.role === 'system') {
        message.sequence = 0
      } else {
        const { sequence } = await SELECT.one`max(sequence) + 1 as sequence`.from(Messages).where({ session: this.ID })
        message.sequence = sequence
      }
      await INSERT(message).into(Messages)
      if (message.role === 'user' || message.type === 'tool_result') this._waiting.resolve()
      callback?.()
    } catch (err) {
      LOG.error('AgentSession write failed', { session: this.ID, error: err.message })
      callback?.(err)
    }
  }

  // can be overwritten to include non persistent context messages
  async *loadSession() {
    const { tools, system, agent, skills } = this.options
    if (tools) yield { role: 'system', type: 'tools', content: tools }
    if (system) yield { role: 'system', type: 'text', content: system }
    if (agent?.content) yield { role: 'system', type: 'text', content: agent.content }
    if (Array.isArray(skills) && skills.length) {
      yield { role: 'system', type: 'text', content: `You have access to the following skills:` }
      for (const skill of skills) yield {
        role: 'system', type: 'text',
        content: `${skill.name}: ${skill.description} (details tool call skill(${skill.name}))`,
      }
    }

    const { Messages } = cds.model.entities('cap.agent')
    for await (const row of SELECT.from(Messages).where({ session: this.ID }).orderBy('sequence'))
      yield row
  }

  _row(msg) {
    if (typeof msg === 'string') msg = { role: 'user', type: 'text', content: msg }
    return { ...msg, session: this.ID }
  }

  async _llm() {
    return (this._llmConn ??= (async () => {
      const { llm } = this.options
      if (!llm) return cds.connect.to('llm')
      if (typeof llm === 'string') return cds.connect.to(llm)
      return cds.connect.to(llm.service ?? 'llm', llm)
    })())
  }
}
