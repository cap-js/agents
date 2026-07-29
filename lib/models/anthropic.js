import cds from "@sap/cds"
import { ChatAnthropic } from "@langchain/anthropic"
import fs from "node:fs"
import path from "node:path"

const LOG = cds.log("agent")

/**
 * `cds.connect.to` compliant langchain model
 * for connecting to an Anthropic compatible API,
 * with autoconfiguration based on env, options,
 * ~/.claude/settings.json and ~/.config/opencode/opencode.json
 */
export default class ChatAnthropicService extends ChatAnthropic {
  constructor(name, model, options) {
    const config = resolveConfig(options)
    super(config)
    this.name = name
    this.options = config
  }
  init() {
    return this
  }
}

function resolveConfig(options = {}) {
  const envConfig = normalize(process.env)
  const chosenConfig = options.anthropicApiUrl
    ? options // revisit: may be better handled via options.credentials
    : envConfig.anthropicApiUrl
      ? envConfig
      : (readClaudeSettings() ?? readOpencodeSettings() ?? {})

  return {
    ...chosenConfig,
    ...options,
    ...compact({ model: options.modelName }),
    ...envConfig,
  }
}

function readClaudeSettings() {
  const settingsPath = findInHome(".claude/settings.json")
  if (!settingsPath) return

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    // https://www.schemastore.org/claude-code-settings.json
    return normalize(settings?.env)
  } catch {
    LOG.debug(`Failed to load claude settings from ${settingsPath}`)
  }
}

function readOpencodeSettings() {
  const settingsPath = findInHome(".config/opencode/opencode.json")
  if (!settingsPath) return

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    // https://opencode.ai/config.json
    const options = settings?.provider?.anthropic?.options
    const model = settings?.model?.replace("anthropic/", "")
    const baseURL = options?.baseURL?.replace(/\/v1$/, "") // opencode expects the versioned baseUrl, others do not
    return normalize(options && { ...options, baseURL, model })
  } catch {
    LOG.debug(`Failed to load opencode settings from ${settingsPath}`)
  }
}

function normalize(o) {
  return (
    o &&
    compact({
      anthropicApiUrl: o.ANTHROPIC_BASE_URL ?? o.anthropicApiUrl ?? o.apiUrl ?? o.baseURL,
      apiKey: o.ANTHROPIC_API_KEY ?? o.ANTHROPIC_AUTH_TOKEN ?? o.anthropicApiKey ?? o.apiKey,
      model: o.ANTHROPIC_MODEL ?? o.modelName ?? o.model,
    })
  )
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function findInHome(relative) {
  const { HOME } = process.env
  if (HOME) {
    const homeCandidate = path.join(HOME, relative)
    if (fs.existsSync(homeCandidate)) {
      return homeCandidate
    }
  }
}

ChatAnthropicService._is_service_class = true
