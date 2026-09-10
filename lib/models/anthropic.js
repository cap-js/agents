import { ChatAnthropic } from '@langchain/anthropic'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import cds from '@sap/cds'
import { withPromptCachingMessages } from '../utils/caching.js'

const HOME = os.homedir() || process.env.HOME || process.env.USERPROFILE
const local = file => file.replace(HOME,'~')
const LOG = cds.log('agents')

/**
 * `cds.connect.to` compliant langchain model
 * for connecting to an Anthropic compatible API,
 * with autoconfiguration based on env, options,
 * ~/.claude/settings.json and ~/.config/opencode/opencode.json
 */
export default class ChatAnthropicService extends ChatAnthropic {
  constructor (name, options) {
    let config = { ...options, ...options?.credentials, ...fromEnv() }
    if (!config.anthropicApiUrl) config = {
      ...fromClaude() || fromOpencode(),
      ...config
    }
    if (LOG._debug) {
      const { kind, model, anthropicApiUrl, apiKey } = config
      LOG.info (`Using effective config:`, {
        kind,
        model,
        credentials: {
          anthropicApiUrl,
          apiKey: apiKey ? '***' : undefined
        }
      })
    }
    super (config)
    this.name = name
    this.options = config
  }

  async _generate (messages, options, runManager) {
    const cached = withPromptCachingMessages(this.model, messages, options)
    return super._generate(cached.messages, cached.opts, runManager)
  }

  async *_streamResponseChunks (messages, options, runManager) {
    const cached = withPromptCachingMessages(this.model, messages, options)
    yield* super._streamResponseChunks(cached.messages, cached.opts, runManager)
  }
}

function fromEnv (env = process.env, silent) {
  let any, config = {}
  if ((any = env.ANTHROPIC_BASE_URL)) config.anthropicApiUrl = any
  if ((any = env.ANTHROPIC_AUTH_TOKEN)) config.apiKey = any
  if ((any = env.ANTHROPIC_API_KEY)) config.apiKey = any
  if ((any = env.ANTHROPIC_MODEL)) config.model = any
  if (!Object.keys(config).length) return null
  if (!silent) LOG.debug (`Loaded Anthropic settings from env:`, config)
  return config
}

function fromClaude() {
  if ('cached' in fromClaude) return fromClaude.cached
  const settings_json = path.join (HOME,'.claude/settings.json')
  try {
    let settings = JSON.parse (fs.readFileSync (settings_json,'utf8'))
    // https://www.schemastore.org/claude-code-settings.json

    let conf = fromClaude.cached = fromEnv (settings?.env, 'silent')
    if (!conf.model && settings.env) {
      let family = (settings.model||'sonnet').toUpperCase()
      conf.model = settings.env[`ANTHROPIC_DEFAULT_${family}_MODEL`] || settings?.model
    }
    LOG.debug(`Loaded Claude settings from`, local(settings_json), ':', conf)
  } catch {
    LOG.debug(`Failed loading Claude settings from`, local(settings_json))
    fromClaude.cached = null
  }
  return fromClaude.cached
}

function fromOpencode() {
  if ('cached' in fromOpencode) return fromOpencode.cached
  const opencode_json = path.join (HOME,'.config/opencode/opencode.json')
  try {
    let conf = JSON.parse (fs.readFileSync (opencode_json,'utf8'))
    LOG.debug(`Loaded OpenCode settings from`, local(opencode_json))
    // https://opencode.ai/config.json
    let o = conf?.provider?.anthropic?.options
    if (!o) return fromOpencode.cached = null
    let any, config = {}
    if ((any = o.anthropicApiUrl ?? o.apiUrl ?? o.baseURL)) config.anthropicApiUrl = any.replace(/\/v1$/,'') // opencode expects the versioned baseUrl, others do not
    if ((any = o.anthropicApiKey ?? o.apiKey)) config.apiKey = any
    if ((any = conf?.model)) config.model = any.replace('anthropic/','')
    fromOpencode.cached = Object.keys(config).length ? config : null
    LOG.debug(`Loaded OpenCode settings from`, local(opencode_json), ':', conf)
  } catch {
    LOG.debug(`Failed loading OpenCode settings from`, local(opencode_json))
    fromOpencode.cached = null
  }
  return fromOpencode.cached
}
