import cds from '@sap/cds'
import { toJSONSchema } from 'zod'
import { Agent } from '@earendil-works/pi-agent-core'

const LOG = cds.log('agents')

export default async function create(srv) {
  const tools = await srv.send('buildTools')
  const llm = await srv.send('buildModel')
  const systemPrompt = await srv.send('buildSystemPrompt')
  if (!llm?.model || typeof llm.streamFn !== 'function') {
    throw new Error(
      'Pi models must expose a model and streamFn; configure a Pi model kind such as pi-anthropic',
    )
  }

  return new Agent({
    initialState: {
      systemPrompt,
      model: llm.model,
      // thinkingLevel: options.thinkingLevel || 'off',
      tools: toPiTools(tools),
      messages: [],
    },
    streamFn: llm.streamFn,
    getApiKey: llm.getApiKey,
  })
}


/** Convert the existing CDS/LangChain tools to Pi's AgentTool contract. */
export function toPiTools(tools = []) {
  return tools
    .map((tool) => {
      let parameters = { type: 'object', properties: {} }
      if (tool.schema) {
        try {
          parameters = toJSONSchema(tool.schema, { target: 'draft-7' })
          delete parameters.$schema
        } catch (error) {
          LOG.warn(`Could not convert schema for Pi tool ${tool.name}`, error.message)
        }
      }

      return {
        name: tool.name,
        label: tool.name,
        description: tool.description || tool.name,
        parameters,
        execute: async (_toolCallId, args, signal) => {
          const result = await tool.invoke(args, { signal })
          return { content: [{ type: 'text', text: toolText(result) }], details: {} }
        },
      }
    })
}


function toolText(result) {
  const value = Array.isArray(result) && result.length === 2 ? result[0] : result
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === 'string' ? part : part?.text || JSON.stringify(part)))
      .join('\n')
  }
  return JSON.stringify(value)
}
