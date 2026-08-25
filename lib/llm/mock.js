import cds from '@sap/cds'
import { LLMService } from './index.js'

const DEFAULT = '[Mock LLM] Mocked response. No real LLM was invoked.'

export default class MockLLMService extends LLMService {
  async *_stream(rows) {
    const tools = []
    const dataRows = []

    for await (const row of rows) {
      if (row.role === 'system' && row.type === 'tools') {
        const defs = row.content ?? {}
        for (const name in defs) tools.push(name)
        continue
      }
      dataRows.push(row)
    }

    const message = this.options?.message || DEFAULT
    const last = dataRows.at(-1)

    if (last?.type === 'tool_result') {
      yield { role: 'assistant', type: 'text', content: `${message}\n\nTool result: ${last.content || ''}` }
      return
    }

    if (tools.length && last?.role === 'user') {
      yield {
        role: 'assistant',
        type: 'tool_call',
        query: { tool: tools[0], id: `mock_${cds.utils.uuid()}`, args: {} },
      }
      return
    }

    yield { role: 'assistant', type: 'text', content: message }
  }
}
