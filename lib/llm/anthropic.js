import os from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'

import cds from '@sap/cds'

import { LLMService } from './index.js'

const HOME = os.homedir()
const LOG = cds.log('agents')
const EPHEMERAL = { type: 'ephemeral' }

export default class AnthropicLLMService extends LLMService {
  async init() {
    await super.init()
    this._config = await this._buildConfig()
  }

  async _buildConfig() {
    const config = fromOptions(this.options) || fromEnv() || (await fromClaude()) || (await fromOpencode())
    if (!config) throw cds.error(`${this.name}: no Anthropic credentials configured — set credentials, ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN`)
    return config
  }

  async _listModels() {
    const { baseURL = 'https://api.anthropic.com', apiKey } = this._config
    if (!apiKey) return null
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/v1/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    })
    if (!res.ok) return null
    const { data } = await res.json()
    return data?.map(m => m.id) ?? null
  }

  _modelPreferences() { return ['opus', 'sonnet', 'haiku'] }

  async *_stream(rows) {
    const model = await this._resolveModel(this.options?.model || this.options?.['x-model'] || cds.env.agents?.model)
    const max_tokens = this.options?.max_tokens || cds.env.agents?.params?.max_tokens || 4096
    const { baseURL = 'https://api.anthropic.com', apiKey } = this._config

    LOG.debug('Anthropic request', { model })

    const prefix = `{"model":${JSON.stringify(model)},"max_tokens":${max_tokens},"stream":true`
    const body = Readable.from(this._toAnthropicMessages(rows, prefix), { objectMode: false })

    const res = await fetch(`${baseURL.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Accept': 'text/event-stream',
      },
      body,
      duplex: 'half',
    })

    if (!res.ok) throw cds.error(`${this.name}: ${res.status} ${await res.text()}`)

    yield* this._buffer(this._parseSSE(res.body))
  }

  async *_toAnthropicMessages(rows, prefix) {
    yield prefix  // {"model":...,"stream":true

    let inTools = false, toolSep = ''
    let inSystem = false, sysSep = ''
    let inMessages = false, msgSep = ''
    let blockSep = '', pendingRole = null, pendingBlock = null

    function* openSystem() {
      if (inSystem) return
      if (inTools) { yield `]`; inTools = false }
      yield `,"system":[`
      inSystem = true
    }

    function* openMsg(role) {
      if (!inMessages) {
        if (inSystem) { yield `]`; inSystem = false }
        else if (inTools) { yield `]`; inTools = false }
        yield `,"messages":[`
        inMessages = true
      }
      yield msgSep + `{"role":"${role}","content":[`
      msgSep = ','; blockSep = ''; pendingRole = role
    }

    function* closeMsg(isLast) {
      if (pendingRole === null) return
      if (pendingBlock) {
        if (isLast && pendingBlock.type === 'text') pendingBlock.cache_control = EPHEMERAL
        yield blockSep + JSON.stringify(pendingBlock)
        pendingBlock = null
      }
      yield ']}'
      pendingRole = null
    }

    function* emitBlock(block) {
      if (pendingBlock) { yield blockSep + JSON.stringify(pendingBlock); blockSep = ',' }
      pendingBlock = block
    }

    for await (const row of rows) {
      if (row.role === 'system' && row.type === 'tools') {
        if (inSystem || inMessages) continue  // ignore tools rows outside their window
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
          yield toolSep + `{"name":${JSON.stringify(name)},"description":${JSON.stringify(description)},"input_schema":${JSON.stringify(parameters)}}`
          toolSep = ','
        }
        continue
      }

      if (row.role === 'system') {
        if (inMessages) continue  // ignore system rows after messages started
        yield* openSystem()
        yield sysSep + `{"type":"text","text":${JSON.stringify(row.content || '')},"cache_control":{"type":"ephemeral"}}`
        sysSep = ','
        continue
      }

      const role = row.role === 'assistant' ? 'assistant' : 'user'
      if (pendingRole !== role) { yield* closeMsg(false); yield* openMsg(role) }
      yield* emitBlock(this._rowToBlock(row))
    }

    yield* closeMsg(true)
    if (!inMessages) {
      if (inSystem) yield `]`
      else if (inTools) yield `]`
      yield `,"messages":[]}`
    } else {
      yield ']}'
    }
  }

  async *_parseSSE(readable) {
    const decoder = new TextDecoder()
    const pendingBlocks = new Map()
    let buf = ''

    for await (const bytes of readable) {
      buf += decoder.decode(bytes, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop()

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        let event
        try { event = JSON.parse(line.slice(6).trim()) } catch { continue }

        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            pendingBlocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, argsJson: '' })
          }
        } else if (event.type === 'content_block_delta') {
          const { delta } = event
          if (delta.type === 'text_delta') {
            yield { role: 'assistant', type: 'text', content: delta.text }
          } else if (delta.type === 'thinking_delta') {
            yield { role: 'assistant', type: 'reasoning', content: delta.thinking }
          } else if (delta.type === 'input_json_delta') {
            const block = pendingBlocks.get(event.index)
            if (block) block.argsJson += delta.partial_json
          }
        } else if (event.type === 'content_block_stop') {
          const block = pendingBlocks.get(event.index)
          if (block) {
            yield {
              role: 'assistant', type: 'tool_call',
              query: { tool: block.name, id: block.id, args: JSON.parse(block.argsJson || '{}') },
            }
            pendingBlocks.delete(event.index)
          }
        } else if (event.type === 'message_stop') {
          return
        }
      }
    }
  }

  _rowToBlock(row) {
    const q = row.query ?? {}
    switch (row.type) {
      case 'text': return { type: 'text', text: row.content || '' }
      case 'reasoning': return { type: 'thinking', thinking: row.content || '' }
      case 'image': return { type: 'image', source: { type: 'url', url: row.content } }
      case 'tool_call': return { type: 'tool_use', id: q.id, name: q.tool, input: q.args || {} }
      case 'tool_result': return {
        type: 'tool_result',
        tool_use_id: q.id,
        content: row.content ?? q.result ?? '{}',
        ...(row.isError && { is_error: true }),
      }
      default: return { type: 'text', text: row.content || '' }
    }
  }
}

// Config loading — priority: CAP options/credentials > env > ~/.claude > ~/.config/opencode
function fromOptions(opts) {
  if (!opts) return null
  const src = opts.credentials || opts
  const config = {}
  if (src.baseURL || src.anthropicApiUrl) config.baseURL = src.baseURL || src.anthropicApiUrl
  if (src.apiKey) config.apiKey = src.apiKey
  return Object.keys(config).length ? config : null
}

function fromEnv(env = process.env) {
  const config = {}
  if (env.ANTHROPIC_BASE_URL) config.baseURL = env.ANTHROPIC_BASE_URL
  if (env.ANTHROPIC_AUTH_TOKEN) config.apiKey = env.ANTHROPIC_AUTH_TOKEN
  if (env.ANTHROPIC_API_KEY) config.apiKey = env.ANTHROPIC_API_KEY
  if (!Object.keys(config).length) return null
  LOG.debug('Loaded Anthropic config from env')
  return config
}

async function fromClaude() {
  if ('cached' in fromClaude) return fromClaude.cached
  try {
    const text = await readFile(path.join(HOME, '.claude/settings.json'), 'utf8')
    fromClaude.cached = fromEnv(JSON.parse(text)?.env)
    if (fromClaude.cached) LOG.debug('Loaded Anthropic config from ~/.claude/settings.json')
  } catch { fromClaude.cached = null }
  return fromClaude.cached
}

async function fromOpencode() {
  if ('cached' in fromOpencode) return fromOpencode.cached
  try {
    const text = await readFile(path.join(HOME, '.config/opencode/opencode.json'), 'utf8')
    const o = JSON.parse(text)?.provider?.anthropic?.options
    if (!o) return (fromOpencode.cached = null)
    const config = {}
    const base = o.anthropicApiUrl ?? o.apiUrl ?? o.baseURL
    if (base) config.baseURL = base.replace(/\/v1$/, '')
    const key = o.anthropicApiKey ?? o.apiKey
    if (key) config.apiKey = key
    fromOpencode.cached = Object.keys(config).length ? config : null
    if (fromOpencode.cached) LOG.debug('Loaded Anthropic config from ~/.config/opencode/opencode.json')
  } catch { fromOpencode.cached = null }
  return fromOpencode.cached
}
