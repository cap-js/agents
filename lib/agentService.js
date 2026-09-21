import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import cds from '@sap/cds'
import { AgentSession } from './session.js'
const { readFile, readdir, stat } = cds.utils.fs.promises

export default class AgentService extends cds.ApplicationService {
  AgentSession = AgentSession

  async init() {
    this.on('start', this.onStart)
    this.on('describe', this.onDescribe)
    this.on('action', this.onAction)
    this.on('query', this.onQuery)
    this.on('skill', this.onSkill)
    return super.init()
  }

  async onStart(req) {
    let options = { ...this.options }
    let service = req.data.service
    if (typeof service === 'string') service = await cds.connect.to(service)
    if (service) options = { ...options, ...await this.deep(service) }
    const session = new this.AgentSession(req.data?.service || this, { ...options, ...req.data.options, ID: req.data?.ID })
    return await this.pipeline(session)
  }

  async onDescribe(req) {
    const NONE = '(none)'
    let { action, entity, service } = req.data || {}

    if (action) {
      if (service) action = `${service}.${action}`
      const def = cds.model.definitions[action]
      return def ? format(def) : `unknown action: ${action}`
    }

    if (entity) {
      if (service) entity = `${service}.${entity}`
      const def = cds.model.definitions[entity]
      return def ? format(def) : `unknown entity: ${entity}`
    }

    if (!service) {
      const names = Object.keys(cds.services).filter(n => n !== 'db' && !n.startsWith('cds.'))
      return `services: ${names.join(', ') || NONE}`
    }

    const svc = cds.services[service]
    if (!svc) return `unknown service: ${service}`
    const entities = Object.values(svc.entities ?? {}).map(format).filter(Boolean)
    const actions  = Object.values(svc.actions  ?? {}).map(format).filter(Boolean)
    return `${service}\nentities:\n${entities.join('\n') || NONE}\nactions:\n${actions.join('\n') || NONE}`

    function format(def) {
      if (!def) return null
      const short = t => (typeof t === 'string' ? t : t?.type ?? 'any').replace(/^cds\./, '')
      const localName = (def.name ?? '').split('.').pop()
      if (def.kind === 'action') {
        const params = Object.entries(def.params ?? {}).map(([n, p]) => `${n}:${short(p)}`).join(', ')
        const ret = def.returns ? ` → ${short(def.returns)}` : ''
        return `  action ${localName}(${params})${ret}`
      }
      const fields = Object.entries(def.elements ?? {})
        .filter(([n]) => !n.startsWith('_'))
        .map(([n, e]) => `${n}:${short(e)}`)
        .join(', ')
      return `  entity ${localName} { ${fields} }`
    }
  }

  async onAction(req) {
    let { service, action, args } = req.data
    if (!service) {
      const split = action.split('.')
      action = split.pop()
      service = split.join('.')
    }
    if (!service) cds.error`The action does not contain the service. Ensure to use the full qualified action name.`
    service = await cds.connect.to(service)
    const res = await service.send(action, args)
    return res
  }

  async onQuery(req) {
    const { cql } = req.data
    const result = await cds.ql(cql)
    return result
  }

  async onSkill(req) {
    const skill = req?.session?.options?.skills?.find(skill => skill.name === req.data.name)
    return skill.content
  }

  async pipeline(session) {
    let ret
    pipeline(
      session,
      store.bind(session),
      hitl.bind(session),
      tools.bind(session),
      async (source) => {
        ret = source
        await new Promise(() => { })
      })
      .catch(() => { })
    ret.session = session
    ret.write = function (a, b, c) { return this.session.write(a, b, c) }
    return ret
  }

  async deep(service) {
    return (service._deep_agent ??= (async () => {
      const tools = { ...this.actions }
      // REVISIT: Might need to be disabled for custom AgentServices
      const hasActions = Object.keys(service.actions).length > 0
      const hasEntities = Object.keys(service.entities).length > 0
      if (!(hasActions || hasEntities)) delete tools['describe']
      if (!hasActions) delete tools['call']
      if (!hasEntities) delete tools['query']

      const { path, find } = cds.utils
      const file = service?.definition?.$location?.file
      if (!file) return {}
      const root = path.dirname(cds.resolve(file)?.[0] ?? file)
      const suffixed = path.resolve(root, service.name)
      const folders = [root, suffixed, suffixed + '-agent']
      for (const folder of folders) {
        const agent = find(folder, ['AGENT.md'])
        if (!agent.length) continue
        const skills = find(folder, ['skills/*/SKILL.md'])
        const [agentContent, ...skillContents] = await Promise.all([
          readFile(agent[0]), ...skills.map(file => readFile(file))
        ])

        if (!skillContents.length) delete tools['skill']

        return {
          tools,
          agent: parse(agentContent),
          skills: skillContents.map(skill => parse(skill))
        }

        function parse(raw) { // Parses AGENT.md and SKILL.md files
          const [_, header, ...content] = `${raw}`.split('---')
          const ret = cds.parse.yaml(header)
          ret.content = content.join('---').trim()
          return ret
        }
      }

      // If no deep agent definition is present
      return { tools }
    })())
  }

}

export async function* store(source) {
  let cur = null
  let prom = null

  for await (const chunk of source) {
    if (chunk.role === 'flush') await flush()
    if (chunk.role === 'assistant' && chunk.type !== 'reasoning') {
      if (cur && cur.role === chunk.role && cur.type === chunk.type) {
        cur.content.write(chunk.content ?? '')
      } else {
        await flush()
        const accumelate = chunk.type === 'text'

        const { content } = chunk
        cur = { ...chunk, ID: chunk.ID ?? cds.utils.uuid(), content: accumelate ? new PassThrough() : content }
        prom = promisify(this.write.bind(this))(cur)
        if (accumelate) cur.content.write(content ?? '')
        else await flush()
      }
    }

    yield chunk
  }
  await flush()

  async function flush() {
    if (!cur) return
    cur.content?.push?.(null)
    await prom
    cur = null
  }
}

export async function* hitl(source) {
  for await (const chunk of source) {
    // TODO: make sure that chunk.tool is fully qualified
    const def = cds.model?.definitions?.[chunk.tool]
    if (def?.['@agent.hitl'] ?? def?.['@Common.IsActionCritical']) {
      return // TODO: create a way to update a HITL tool call to have been decided
    }
    yield chunk
  }
}

export async function* tools(source) {
  const write = promisify(this.write.bind(this))
  let activeToolCalls = []

  for await (const chunk of source) {
    if (activeToolCalls.length && chunk.role === 'flush') {
      for (const result of await Promise.all(activeToolCalls)) {
        await write(result)
        yield result
      }
      activeToolCalls = []
      continue // consume flush event
    }
    if (chunk.type !== 'tool_call') { yield chunk; continue }

    const query = chunk.query ?? {}

    activeToolCalls.push((async () => {
      if (query.tool === 'query') {
        const rows = query.args?.cql
          ? await cds.run(cds.parse.cql(query.args.cql))
          : await this.srv.read(query.args?.entity, query.args)
        return JSON.stringify(rows ?? [])
      }
      const action = this.options.tools[query.tool]
      const srv = await cds.connect.to(action._service.name)
      const res = await srv.send({ event: query.tool, data: query.args ?? {}, session: this })
      return !res || typeof res === 'string' || res[Symbol.asyncIterator] ? res : JSON.stringify(res ?? null)
    })()
      .catch(err => JSON.stringify({ error: err.message }))
      .then(content => ({
        ID: cds.utils.uuid(),
        role: 'tool', type: 'tool_result', content,
        query: { id: query.id, tool: query.tool }
      })
    ))

    yield chunk
  }
}
