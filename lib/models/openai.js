import { ChatOpenAI } from '@langchain/openai'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import cds from '@sap/cds'

const HOME = os.homedir() || process.env.HOME || process.env.USERPROFILE
const LOG = cds.log('agents')

/**
 * `cds.connect.to` compliant langchain model
 * for connecting to an OpenAI compatible API,
 * with autoconfiguration based on env, options,
 * and ~/.config/opencode/opencode.json
 */
export default class ChatOpenAIService extends ChatOpenAI {
  constructor (name, options) {
    const config = openaiConfig(options)
    LOG.debug (`Using effective config for ChatOpenAI:`, config)
    super (config)
    this.name = name
    this.options = config
  }
}

/** Shared OpenAI auto-configuration for LangChain and Pi models. */
export function openaiConfig (options = {}) {
  let config = { ...options, ...fromEnv() }
  if (!config.openaiBaseUrl) config = {
    ...fromOpencode(),
    ...config
  }
  return config
}

function fromEnv (env = process.env) {
  let any, config = {}
  if ((any = env.OPENAI_BASE_URL)) config.openaiBaseUrl = any
  if ((any = env.OPENAI_API_KEY)) config.apiKey = any
  if ((any = env.OPENAI_MODEL)) config.model = any
  if (!Object.keys(config).length) return null
  LOG.debug (`Loaded OpenAI settings from env:`, config)
  return config
}

function fromOpencode() {
  if ('cached' in fromOpencode) return fromOpencode.cached
  const opencode_json = path.join (HOME,'.config/opencode/opencode.json')
  try {
    let conf = JSON.parse (fs.readFileSync (opencode_json,'utf8'))
    LOG.debug(`Loaded OpenCode settings from`, opencode_json)
    // https://opencode.ai/config.json
    let o = conf?.provider?.openai?.options
    if (!o) return fromOpencode.cached = null
    let any, config = {}
    if ((any = o.baseURL ?? o.openaiBaseUrl)) config.openaiBaseUrl = any
    if ((any = o.apiKey)) config.apiKey = any
    if ((any = conf?.model)) config.model = any.replace('openai/','')
    fromOpencode.cached = Object.keys(config).length ? config : null
    LOG.debug(`Loaded OpenCode settings from`, opencode_json, ':', conf)
  } catch {
    LOG.debug(`Failed loading OpenCode settings from`, opencode_json)
    fromOpencode.cached = null
  }
  return fromOpencode.cached
}
