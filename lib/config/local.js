import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import cds from "@sap/cds"

const HOME = os.homedir() || process.env.HOME || process.env.USERPROFILE
const local = (file) => file.replace(HOME, "~")
const LOG = cds.log("agents")

/**
 * Autoconfiguration for anthropic -> openai -> mock
 */
export function resolve_config(options) {
  let config = resolve_anthropic_config(options)
  if (config?.credentials?.anthropicApiUrl || config?.credentials?.apiKey) return config
  config = resolve_openai_config(options)
  if (config?.credentials?.openaiBaseUrl || config?.credentials?.apiKey) return config
  return { kind: "mock" }
}

/**
 * Anthropic autoconfiguration based on env, options,
 * ~/.claude/settings.json and ~/.config/opencode/opencode.json
 */
export function resolve_anthropic_config(options) {
  let config = fromAnthropicEnv()
  if (!config?.anthropicApiUrl)
    config = {
      ...config,
      ...(fromClaude() || fromOpencode()),
    }
  let { model, ...credentials } = config
  return {
    kind: "anthropic",
    model: options?.model || model,
    credentials: {
      ...credentials,
      ...options?.credentials,
    },
  }
}

function fromAnthropicEnv(env = process.env, silent) {
  let any,
    config = {}
  if ((any = env.ANTHROPIC_BASE_URL)) config.anthropicApiUrl = any
  if ((any = env.ANTHROPIC_AUTH_TOKEN)) config.apiKey = any
  if ((any = env.ANTHROPIC_API_KEY)) config.apiKey = any
  if ((any = env.ANTHROPIC_MODEL)) config.model = any
  if (!Object.keys(config).length) return null
  if (!silent) LOG.debug(`Loaded Anthropic settings from env:`, config)
  return config
}

function fromClaude() {
  if ("cached" in fromClaude) return fromClaude.cached
  const settings_json = path.join(HOME, ".claude/settings.json")
  try {
    let settings = JSON.parse(fs.readFileSync(settings_json, "utf8"))
    // https://www.schemastore.org/claude-code-settings.json

    let conf = (fromClaude.cached = fromAnthropicEnv(settings?.env, "silent"))
    if (!conf.model && settings.env) {
      let family = (settings.model || "sonnet").toUpperCase()
      conf.model = settings.env[`ANTHROPIC_DEFAULT_${family}_MODEL`] || settings?.model
    }
    LOG.debug(`Loaded config from`, local(settings_json), ":", sanitized(conf))
  } catch {
    LOG.debug(`Failed loading Claude settings from`, local(settings_json))
    fromClaude.cached = null
  }
  return fromClaude.cached
}

function fromOpencode() {
  if ("cached" in fromOpencode) return fromOpencode.cached
  const opencode_json = path.join(HOME, ".config/opencode/opencode.json")
  try {
    let conf = JSON.parse(fs.readFileSync(opencode_json, "utf8"))
    LOG.debug(`Loaded OpenCode settings from`, local(opencode_json))
    // https://opencode.ai/config.json
    let o = conf?.provider?.anthropic?.options
    if (!o) return (fromOpencode.cached = null)
    let any,
      config = {}
    if ((any = o.anthropicApiUrl ?? o.apiUrl ?? o.baseURL))
      config.anthropicApiUrl = any.replace(/\/v1$/, "") // opencode expects the versioned baseUrl, others do not
    if ((any = o.anthropicApiKey ?? o.apiKey)) config.apiKey = any
    if ((any = conf?.model)) config.model = any.replace("anthropic/", "")
    fromOpencode.cached = Object.keys(config).length ? config : null
    LOG.debug(`Loaded config from`, local(opencode_json), ":", sanitized(config))
  } catch {
    LOG.debug(`Failed loading OpenCode settings from`, local(opencode_json))
    fromOpencode.cached = null
  }
  return fromOpencode.cached
}


/**
 * OpenAI autoconfiguration based on env, options,
 * ~/.codex/config.toml and ~/.config/opencode/opencode.json
 */
export function resolve_openai_config(options = {}) {
  let config = fromOpenAIEnv()
  if (!config?.openaiBaseUrl) config = {
    ...config,
    ...fromCodex(), ...(fromOpencodeOpenAI()),
  }
  let { model, ...credentials } = config
  return {
    kind: "openai",
    model: options?.model || model,
    credentials: {
      ...credentials,
      ...options?.credentials
    }
  }
}

function fromOpenAIEnv(env = process.env) {
  let any,
    config = {}
  if ((any = env.OPENAI_BASE_URL)) config.openaiBaseUrl = any
  if ((any = env.OPENAI_API_KEY)) config.apiKey = any
  if ((any = env.OPENAI_MODEL)) config.model = any
  if (!Object.keys(config).length) return null
  LOG.debug(`Loaded OpenAI settings from env:`, config)
  return config
}

function fromCodex() {
  if ("cached" in fromCodex) return fromCodex.cached
  const codex_toml = path.join(HOME, ".codex/config.toml")
  try {
    let raw = fs.readFileSync(codex_toml, "utf8")
    LOG.debug(`Loaded Codex settings from`, local(codex_toml))
    // minimal TOML parse: top-level model and [model_providers.openai] section
    let model = raw.match(/^model\s*=\s*"([^"]+)"/m)?.[1]
    let section = raw.match(/\[model_providers\.openai\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? ""
    let baseUrl = section.match(/base_url\s*=\s*"([^"]+)"/)?.[1]
    let envKey = section.match(/env_key\s*=\s*"([^"]+)"/)?.[1]
    let bearerToken = section.match(/experimental_bearer_token\s*=\s*"([^"]+)"/)?.[1]
    let apiKey = (envKey && process.env[envKey]) || bearerToken
    let config = {}
    if (baseUrl) config.openaiBaseUrl = baseUrl
    if (apiKey) config.apiKey = apiKey
    if (model) config.model = model
    fromCodex.cached = Object.keys(config).length ? config : null
    LOG.debug(`Loaded config from`, local(codex_toml), ":", sanitized(config))
  } catch {
    LOG.debug(`Failed loading Codex settings from`, local(codex_toml))
    fromCodex.cached = null
  }
  return fromCodex.cached
}

function fromOpencodeOpenAI() {
  if ("cached" in fromOpencodeOpenAI) return fromOpencodeOpenAI.cached
  const opencode_json = path.join(HOME, ".config/opencode/opencode.json")
  try {
    let conf = JSON.parse(fs.readFileSync(opencode_json, "utf8"))
    LOG.debug(`Loaded OpenCode settings from`, local(opencode_json))
    // https://opencode.ai/config.json
    let o = conf?.provider?.openai?.options
    if (!o) return (fromOpencodeOpenAI.cached = null)
    let any,
      config = {}
    if ((any = o.baseURL ?? o.openaiBaseUrl)) config.openaiBaseUrl = any
    if ((any = o.apiKey)) config.apiKey = any
    if ((any = conf?.model)) config.model = any.replace("openai/", "")
    fromOpencodeOpenAI.cached = Object.keys(config).length ? config : null
    LOG.debug(`Loaded config from`, local(opencode_json), ":", sanitized(fromOpencodeOpenAI.cached || {}))
  } catch {
    LOG.debug(`Failed loading OpenCode settings from`, local(opencode_json))
    fromOpencodeOpenAI.cached = null
  }
  return fromOpencodeOpenAI.cached
}

const sanitized = ({ apiKey, ...rest }) => ({
  ...rest,
  apiKey: apiKey ? "***" : undefined,
})
