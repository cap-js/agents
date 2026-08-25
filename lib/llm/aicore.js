import cds from '@sap/cds'
import { OrchestrationClient } from '@sap-ai-sdk/orchestration'
import { circuitBreaker, timeout } from '@sap-cloud-sdk/resilience'
import { LLMService } from './index.js'

const LOG = cds.log('agents')

export default class AICoreService extends LLMService {
  async init() {
    await super.init()
    const opts = this.options || {}
    this._model_name = await this._resolveModel(opts.model || opts['x-model'] || cds.env.agents?.model)
    this._max_tokens = opts.max_tokens || cds.env.agents?.params?.max_tokens || 4096
    this._temperature = opts.temperature ?? cds.env.agents?.params?.temperature ?? 0
  }

  _buildClient(tools) {
    const opts = this.options || {}
    const promptTemplating = {
      model: { name: this._model_name, params: { max_tokens: this._max_tokens, temperature: this._temperature } },
    }
    if (tools.length) promptTemplating.prompt = { tools }
    return new OrchestrationClient(
      { promptTemplating, ...this._filteringConfig(opts) },
      this._deploymentConfig(opts),
    )
  }

  _deploymentConfig({ destinationName, resourceGroup } = {}) {
    if (destinationName) return { destinationName, resourceGroup: resourceGroup || 'default' }
    if (resourceGroup) return { resourceGroup }
    return undefined
  }

  _filteringConfig({ contentFilter } = {}) {
    if (!contentFilter) return {}
    return {
      filtering: {
        output: {
          filters: [{ type: 'azure_content_safety', config: { hate: 0, violence: 4 } }],
        },
      },
    }
  }

  _modelPreferences() { return ['anthropic--claude-opus-5', 'anthropic--claude-sonnet-5', 'anthropic--claude-haiku-5'] }

  async *_stream(rows) {
    const { messagesHistory, messages, tools } = await this._toAICoreMessages(rows)
    LOG.debug('AICore request', { history: messagesHistory.length, messages: messages.length })

    const api = await this._buildClient(tools).stream(
      { messagesHistory, messages },
      undefined,
      undefined,
      this._requestConfig(),
    )

    yield* this._buffer(async function* () {
      const pendingTools = new Map()
      for await (const chunk of api) {
        const text = chunk.getDeltaContent()
        if (text) yield { role: 'assistant', type: 'text', content: text }

        const reasoning = chunk.getDeltaReasoningContent()
        if (reasoning?.length) {
          for (const r of reasoning) {
            if (r) yield { role: 'assistant', type: 'reasoning', content: r }
          }
        }

        const toolDeltas = chunk.getDeltaToolCalls()
        if (toolDeltas?.length) {
          for (const delta of toolDeltas) {
            const { index, id, function: fn } = delta
            if (!pendingTools.has(index)) pendingTools.set(index, { id: '', name: '', argsJson: '' })
            const tc = pendingTools.get(index)
            if (id) tc.id = id
            if (fn?.name) tc.name = fn.name
            if (fn?.arguments) tc.argsJson += fn.arguments
          }
        }

        if (chunk.getFinishReason() === 'tool_calls') {
          for (const [, tc] of pendingTools) {
            yield {
              role: 'assistant',
              type: 'tool_call',
              query: { tool: tc.name, id: tc.id, args: JSON.parse(tc.argsJson || '{}') },
            }
          }
          pendingTools.clear()
        }
      }
    }())
  }

  async _toAICoreMessages(rows) {
    const toolDefs = []
    const _json_schema = this.constructor._json_schema

    async function* nonToolRows() {
      for await (const row of rows) {
        if (row.role === 'system' && row.type === 'tools') {
          const tools = row.content ?? {}
          for (const name in tools) {
            const t = tools[name]
            const description = t.description || t['@description'] || ''
            const parameters = { type: 'object', properties: {}, required: [] }
            for (const param in t.params ?? {}) {
              const element = t.params[param]
              parameters.properties[param] = element[_json_schema](element)
              if (element.notNull) parameters.required.push(param)
            }
            toolDefs.push({ type: 'function', function: { name, description, parameters } })
          }
          continue
        }
        yield row
      }
    }

    const messagesHistory = []
    let last = null
    for await (const turn of this._toTurns(nonToolRows())) {
      if (last) messagesHistory.push(last)
      last = {
        role: turn.role,
        content: turn.parts.length === 1 && turn.parts[0].type === 'text'
          ? (turn.parts[0].content || '')
          : turn.parts.map(p => this._rowToBlock(p)),
      }
    }
    return { messagesHistory, messages: last ? [last] : [], tools: toolDefs }
  }

  _rowToBlock(row) {
    const q = row.query ? (typeof row.query === 'string' ? JSON.parse(row.query) : row.query) : {}
    switch (row.type) {
      case 'text':
        return { type: 'text', text: row.content || '' }
      case 'image':
        return { type: 'image_url', image_url: { url: row.content } }
      case 'tool_call':
        return { type: 'tool_use', id: q.id, name: q.tool, input: q.args || {} }
      case 'tool_result':
        return row.content ?? JSON.stringify(q.result ?? {})
      default:
        return { type: 'text', text: row.content || '' }
    }
  }

  _requestConfig() {
    const ms = cds.utils.ms4(cds.env.agents?.pool?.maxLLMCallTimeout || '120s')
    return { customRequestConfig: { middleware: [timeout(ms), circuitBreaker()] } }
  }
}
