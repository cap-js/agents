import { ChatAnthropic } from '@langchain/anthropic'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import cds from '@sap/cds'

const HOME = os.homedir() || process.env.HOME || process.env.USERPROFILE
const LOG = cds.log('agents')

/**
 * `cds.connect.to` compliant langchain model
 * for connecting to an Anthropic compatible API,
 * with autoconfiguration based on env, options,
 * ~/.claude/settings.json and ~/.config/opencode/opencode.json
 */
export default class ChatAnthropicService extends ChatAnthropic {
  constructor (name, options) {
    const config = anthropicConfig(options)
    LOG.debug (`Using effective config for ChatAnthropic:`, config)
    super (config)
    this.name = name
    this.options = config
  }
}

/** Shared Anthropic auto-configuration for LangChain and Pi models. */
export function anthropicConfig (options = {}) {
  // REVISIT: may be better handled via options.credentials?
  let config = { ...options, ...fromEnv() }
  if (!config.anthropicApiUrl) config = {
    ...fromClaude() || fromOpencode(),
    ...config
  }
  return config
}

function fromEnv (env = process.env) {
  let any, config = {}
  if ((any = env.ANTHROPIC_BASE_URL)) config.anthropicApiUrl = any
  if ((any = env.ANTHROPIC_AUTH_TOKEN)) config.apiKey = any
  if ((any = env.ANTHROPIC_API_KEY)) config.apiKey = any
  if ((any = env.ANTHROPIC_MODEL)) config.model = any
  if (!Object.keys(config).length) return null
  LOG.debug (`Loaded Anthropic settings from env:`, config)
  return config
}

function fromClaude() {
  if ('cached' in fromClaude) return fromClaude.cached
  const settings_json = path.join (HOME,'.claude/settings.json')
  try {
    let conf = JSON.parse (fs.readFileSync (settings_json,'utf8'))
    // https://www.schemastore.org/claude-code-settings.json
    fromClaude.cached = conf = fromEnv (conf?.env)
    LOG.debug(`Loaded Claude settings from`, settings_json, ':', conf)
  } catch {
    LOG.debug(`Failed loading Claude settings from`, settings_json)
    fromClaude.cached = null
  }
  return fromClaude.cached
}

function fromOpencode() {
  if ('cached' in fromOpencode) return fromOpencode.cached
  const opencode_json = path.join (HOME,'.config/opencode/opencode.json')
  try {
    let conf = JSON.parse (fs.readFileSync (opencode_json,'utf8'))
    LOG.debug(`Loaded OpenCode settings from`, opencode_json)
    // https://opencode.ai/config.json
    let o = conf?.provider?.anthropic?.options
    if (!o) return fromOpencode.cached = null
    let any, config = {}
    if ((any = o.anthropicApiUrl ?? o.apiUrl ?? o.baseURL)) config.anthropicApiUrl = any.replace(/\/v1$/,'') // opencode expects the versioned baseUrl, others do not
    if ((any = o.anthropicApiKey ?? o.apiKey)) config.apiKey = any
    if ((any = conf?.model)) config.model = any.replace('anthropic/','')
    fromOpencode.cached = Object.keys(config).length ? config : null
    LOG.debug(`Loaded OpenCode settings from`, opencode_json, ':', conf)
  } catch {
    LOG.debug(`Failed loading OpenCode settings from`, opencode_json)
    fromOpencode.cached = null
  }
  return fromOpencode.cached
}
