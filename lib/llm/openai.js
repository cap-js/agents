import cds from '@sap/cds'
import { Readable } from 'node:stream'
import { LLMService } from './index.js'

const LOG = cds.log('agents')

export default class OpenAILLMService extends LLMService {
  async init() {
    await super.init()
    this._config = await this._buildConfig()
  }

  async _buildConfig() {
    const config = fromOptions(this.options) || fromEnv() || (await fromDockerModelRunner())
    if (!config) throw cds.error(`${this.name}: no LLM credentials configured — set credentials, OPENAI_API_KEY, or start Docker Model Runner`)
    return config
  }

  async _listModels() {
    const { baseURL, apiKey = 'local' } = this._config
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, { headers: { 'Authorization': `Bearer ${apiKey}` } })
    if (!res.ok) return null
    const { data } = await res.json()
    return data?.map(m => m.id) ?? null
  }

  _modelPreferences() {
    return [
      'o3', 'o1',
      'gpt-4o', 'gpt-4',
      'qwen3', 'llama3', 'deepseek-r1', 'mistral-large', 'mixtral', 'gemma3', 'phi-4',
      'gpt-3.5', 'qwen', 'llama', 'deepseek', 'mistral', 'gemma', 'phi',
    ]
  }

  async *_stream(rows) {
    const model = await this._resolveModel(this.options?.model || this.options?.['x-model'] || cds.env.agents?.model)
    const max_tokens = this.options?.max_tokens || cds.env.agents?.params?.max_tokens || 4096
    const { baseURL, apiKey = 'local' } = this._config

    LOG.debug('OpenAI request', { model })

    const prefix = `{"model":${JSON.stringify(model)},"max_tokens":${max_tokens},"stream":true,"stream_options": {"include_usage": true}`
    const body = Readable.from(this._toOpenAIMessages(rows, prefix), { objectMode: false })

    const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Accept': 'text/event-stream' },
      body,
      duplex: 'half',
    })

    if (!res.ok) throw cds.error(`${this.name}: ${res.status} ${await res.text()}`)

    yield* this._buffer(this._parseSSE(res.body))
  }

  async *_parseSSE(readable) {
    const decoder = new TextDecoder()
    const pendingTools = new Map()
    let buf = ''

    for await (const bytes of readable) {
      buf += decoder.decode(bytes, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop()

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') return
        let event
        try { event = JSON.parse(data) } catch { continue }

        const choice = event.choices?.[0]
        const delta = choice?.delta
        if (!delta) continue

        if (delta.content != null) yield { role: 'assistant', type: 'text', content: delta.content }

        if (delta.tool_calls?.length) {
          for (const tc of delta.tool_calls) {
            if (!pendingTools.has(tc.index)) pendingTools.set(tc.index, { id: '', name: '', argsJson: '' })
            const pending = pendingTools.get(tc.index)
            if (tc.id) pending.id = tc.id
            if (tc.function?.name) pending.name = tc.function.name
            if (tc.function?.arguments) pending.argsJson += tc.function.arguments
          }
        }

        if (choice?.finish_reason === 'tool_calls') {
          for (const [, tc] of pendingTools) {
            yield { role: 'assistant', type: 'tool_call', query: { tool: tc.name, id: tc.id, args: JSON.parse(tc.argsJson || '{}') } }
          }
          pendingTools.clear()
        }
      }
    }
  }

  async *_toOpenAIMessages(rows, prefix) {
    yield prefix

    let inTools = false, toolSep = ''
    let inMessages = false, sep = ''
    let asst = null
    let inSystemMsg = false  // system message is open, appending content
    let pastSystem = false   // system section ended, skip any further system rows

    for await (const row of rows) {
      if (row.role === 'system' && row.type === 'tools') {
        if (inMessages) continue
        if (!inTools) { yield `,"tools":[`; inTools = true }
        const tools = row.content ?? {}
        for (const name in tools) {
          const t = tools[name]
          const description = t.description || t['@description'] || ''
          const parameters = { type: 'object', properties: {}, required: [] }
          for (const param in t.params ?? {}) {
            const element = t.params[param]
            parameters.properties[param] = element[this.constructor._json_schema](element)
            if (element.notNull) parameters.required.push(param)
          }
          yield toolSep + `{"type":"function","function":{"name":${JSON.stringify(name)},"description":${JSON.stringify(description)},"parameters":${JSON.stringify(parameters)}}}`
          toolSep = ','
        }
        continue
      }

      if (!inMessages) {
        if (inTools) yield `]`
        yield `,"messages":[`
        inMessages = true
      }

      if (row.role === 'system') {
        if (pastSystem) continue
        if (!inSystemMsg) {
          yield sep + '{"role":"system","content":"' + JSON.stringify(row.content || '').slice(1, -1)
          sep = ','
          inSystemMsg = true
        } else {
          yield '\\n' + JSON.stringify(row.content || '').slice(1, -1)
        }
        continue
      }

      // Close the open system message before emitting any non-system content
      if (inSystemMsg) { yield '"}'; inSystemMsg = false }
      pastSystem = true

      if (row.role !== 'assistant' && asst) {
        yield sep + `{"role":"assistant"` +
          (asst.content != null ? `,"content":${JSON.stringify(asst.content)}` : '') +
          (asst.calls ? `,"tool_calls":${JSON.stringify(asst.calls)}` : '') + '}'
        sep = ','; asst = null
      }

      if (row.role === 'tool') {
        const q = row.query ?? {}
        yield sep + `{"role":"tool","tool_call_id":${JSON.stringify(q.id)},"content":${JSON.stringify(row.content ?? q.result ?? '{}')}}`
        sep = ','
      } else if (row.role === 'user') {
        yield sep + (row.type === 'image'
          ? `{"role":"user","content":[{"type":"image_url","image_url":{"url":${JSON.stringify(row.content)}}}]}`
          : `{"role":"user","content":${JSON.stringify(row.content || '')}}`)
        sep = ','
      } else if (row.role === 'assistant') {
        if (!asst) asst = {}
        if (row.type === 'tool_call') {
          const q = row.query ?? {}
            ; (asst.calls ??= []).push({ id: q.id, type: 'function', function: { name: q.tool, arguments: JSON.stringify(q.args || {}) } })
        } else {
          asst.content = (asst.content || '') + (row.content || '')
        }
      }
    }

    if (inSystemMsg) yield '"}'
    if (asst) {
      yield sep + `{"role":"assistant"` +
        (asst.content != null ? `,"content":${JSON.stringify(asst.content)}` : '') +
        (asst.calls ? `,"tool_calls":${JSON.stringify(asst.calls)}` : '') + '}'
    }
    if (!inMessages) {
      if (inTools) yield `]`
      yield `,"messages":[]}`
    } else {
      yield ']}'
    }
  }
}

// Config loading — priority: CAP options/credentials > env > Docker Model Runner
function fromOptions(opts) {
  if (!opts) return null
  const src = opts.credentials || opts
  const config = {}
  if (src.baseURL) config.baseURL = src.baseURL
  if (src.apiKey) config.apiKey = src.apiKey
  return Object.keys(config).length ? config : null
}

function fromEnv(env = process.env) {
  const config = {}
  if (env.OPENAI_BASE_URL) config.baseURL = env.OPENAI_BASE_URL
  if (env.OPENAI_API_KEY) config.apiKey = env.OPENAI_API_KEY
  if (!Object.keys(config).length) return null
  LOG.debug('Loaded OpenAI config from env')
  return config
}

async function fromDockerModelRunner() {
  const candidates = [
    'http://localhost:12434/engines/v1',
    'http://docker.host.internal:12434/engines/v1',
  ]
  for (const baseURL of candidates) {
    try {
      const res = await fetch(`${baseURL}/models`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        LOG.debug(`Using Docker Model Runner at ${baseURL}`)
        return { baseURL, apiKey: 'local' }
      }
    } catch { /* unreachable host */ }
  }
  return null
}
