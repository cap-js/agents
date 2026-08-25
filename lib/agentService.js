import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import cds from '@sap/cds'
import { AgentSession } from './session.js'

const { readFile, readdir, stat } = cds.utils.fs.promises

export default class AgentService extends cds.ApplicationService {
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
    const session = new AgentSession(req.data?.service || this, { ...options, ...req.data.options, ID: req.data?.ID })
    return await this.pipeline(session)
  }

  async onDescribe(req) {
    // const skill = req?.session?.options?.skills?.find(skill => skill.name === req.data.name)
    return `You have successfully called the describe tool.`
  }

  async onAction(req) {
    // const skill = req?.session?.options?.skills?.find(skill => skill.name === req.data.name)
    return `You have successfully called the action tool.`
  }

  async onQuery(req) {
    // const skill = req?.session?.options?.skills?.find(skill => skill.name === req.data.name)
    return `You have successfully called the query tool.`
  }

  async onSkill(req) {
    // const skill = req?.session?.options?.skills?.find(skill => skill.name === req.data.name)
    // return skill.content
    return `You have successfully called the skill tool.`
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

        const tools = { ...this.actions }

        const hasActions = Object.keys(service.actions).length > 0
        const hasEntities = Object.keys(service.entities).length > 0
        for (const tool in tools) { // REVISIT: Migh need to be dsiabled for custom AgentServices
          if (tool === 'skill' && !skillContents.length) delete tools[tool]
          if (tool === 'describe' && !(hasActions || hasEntities)) delete tools[tool]
          if (tool === 'call' && !hasActions) delete tools[tool]
          if (tool === 'query' && !hasEntities) delete tools[tool]
        }

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
    })())
  }

}

export async function* store(source) {
  let cur = null
  let prom = null

  this.on('pause', () => {
    debugger
    return flush()
  })

  for await (const chunk of source) {
    if (chunk.role === 'flush') await flush()
    if (chunk.role === 'assistant' && chunk.type !== 'reasoning') {
      if (cur && cur.role === chunk.role && cur.type === chunk.type) {
        cur.content.write(JSON.stringify(chunk.content ?? '').slice(1, -1))
      } else {
        await flush()
        const accumelate = chunk.type === 'text'

        const { content } = chunk
        cur = { ...chunk, ID: chunk.ID ?? cds.utils.uuid(), content: accumelate ? new PassThrough() : content }
        prom = promisify(this.write.bind(this))(cur)
        if (accumelate) cur.content.write(JSON.stringify(content ?? '').slice(1, -1))
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
      return typeof res === 'string' ? res : JSON.stringify(res ?? null)

    })()
      .catch(err => JSON.stringify({ error: err.message }))
      .then(content => ({
        ID: cds.utils.uuid(),
        role: 'tool', type: 'tool_result', content,
        query: { id: query.id, tool: query.tool }
      })))

    yield chunk
  }
}
