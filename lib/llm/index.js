import cds from '@sap/cds'
import { getDefaultHighWaterMark } from 'node:stream'

const LOG = cds.log('agents')

export class LLMService extends cds.ApplicationService {
  async init() {
    this.on('*', this.onPrompt)
    // TODO: move to one time init
    this.constructor._json_schema = this.constructor._add_mixins(':types', this.constructor.types)
    return super.init()
  }

  async onPrompt(req) {
    const { iterator, query, data, event } = req
    const rows = this._collectInput(query || data || event)
    const stream = this._stream(rows)

    if (iterator) return stream

    const messages = []
    for await (const chunk of stream) messages.push(chunk)
    return messages
  }

  async *_buffer(raw) {
    const hwm = 1 ?? this.options?.highWaterMark ?? cds.env.agents?.llm?.highWaterMark ?? getDefaultHighWaterMark(false)
    let buf = null

    for await (const chunk of raw) {
      if (chunk.type === 'tool_call' || chunk.type === 'reasoning') {
        if (buf) { yield buf; buf = null }
        yield chunk
        continue
      }
      if (buf && (buf.role !== chunk.role || buf.type !== chunk.type)) {
        yield buf
        buf = null
      }
      if (!buf) {
        buf = chunk
      } else {
        buf.content = (buf.content || '') + (chunk.content || '')
      }
      if (buf.content?.length >= hwm) {
        yield buf
        buf = null
      }
    }
    if (buf) yield buf
  }

  // Pass through any iterable/async-iterable as-is; wrap scalars in a single-row array
  _collectInput(input) {
    if (!input) return []
    if (typeof input === 'string') return [{ role: 'user', type: 'text', content: input }]
    if (Array.isArray(input)) return input
    if (typeof input[Symbol.asyncIterator] === 'function') return input
    if (typeof input[Symbol.iterator] === 'function') return input
    return [input]
  }

  // Stream rows into grouped turns without materializing the full row set
  async *_toTurns(rows) {
    let last = null
    for await (const row of rows) {
      if (last && last.role === row.role) last.parts.push(row)
      else { if (last) yield last; last = { role: row.role, parts: [row] } }
    }
    if (last) yield last
  }

  _resolveModel(model) {
    return (this._resolvedModel ??= (async () => {
      const list = await this._listModels()
      if (!list?.length && !model) cds.error`No Models available`
      if (!list?.length) return model

      if (model) return list.find(id => id === model) || match(model) || model

      if (list.length) {
        const prefs = await this._modelPreferences()
        for (const pref of prefs) {
          const m = match(pref)
          if (m) return m
        }
        LOG.debug(`Using first available model: ${list[0]}`)
        return list[0]
      }

      cds.error`${this.name}: no model configured`

      function match(model) {
        const matches = list
          .filter(id => id.toLowerCase().includes(model.toLowerCase()))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        if (matches.length >= 1) {
          if (matches.length > 1) LOG.warn(`Model "${model}" matches multiple: ${matches.join(', ')} — using ${matches[0]}`)
          else LOG.debug(`Resolved model "${model}" → "${matches[0]}"`)
          return matches[0]
        }
      }
    })())
  }

  // TODO: add description mapping from modeling
  static types = {
    UUID: () => ({ type: 'string', pattern: `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$` }),
    String: e => ({ type: 'string', maxLength: e.length || 5000 }),
    Binary: e => ({ type: 'string', maxLength: e.length || 5000 }),
    UInt8: () => ({ type: 'integer', minimum: 0, maximum: 256 }),
    Int16: () => ({ type: 'integer', minimum: -(2 ** 15), maximum: 2 ** 15 }),
    Int32: () => ({ type: 'integer', minimum: -(2 ** 31), maximum: 2 ** 31 }),
    Int64: () => ({ type: 'integer', minimum: -(2n ** 63n), maximum: 2n ** 63n }),
    Integer: () => ({ type: 'integer', minimum: -(2 ** 53), maximum: 2 ** 53 }),
    Integer64: () => ({ type: 'integer', minimum: -(2n ** 63n), maximum: 2n ** 63n }),
    // TODO: double check LargeString and LargeBinary as realistically they have a cap
    //       ~500MiB(v8 string), ~2GiB(blob) or ~4GiB(blob NSE)
    LargeString: () => ({ type: 'string' }),
    LargeBinary: () => ({ type: 'string' }),
    // TODO: make cyclic for associations and typed arrays
    Association: e => (e.is2one ? { type: 'object' } : { type: 'array' }),
    Composition: e => (e.is2one ? { type: 'object' } : { type: 'array' }),
    array: () => ({ type: 'array' }),
    Map: () => ({ type: 'object' }),
  }

  static _add_mixins(aspect, mixins) {
    const fqn = this.name + aspect
    const types = cds.builtin.types
    for (let each in mixins) {
      const def = types[each]
      if (!def) continue
      const value = mixins[each]
      if (value?.get) Object.defineProperty(def, fqn, { get: value.get })
      else Object.defineProperty(def, fqn, { value })
    }
    return fqn
  }

  async _listModels() { return null }
  async _modelPreferences() { return [] }

  async *_stream(_rows) { cds.error`${this.name}: _stream() not implemented` }
}
