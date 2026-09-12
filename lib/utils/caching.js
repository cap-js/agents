import cds from "@sap/cds"

export const PROMPT_CACHE_MODEL_PARAMS = Symbol("promptCacheModelParams")

const CACHE_CONTROL_EPHEMERAL = { type: "ephemeral" }

export function isPromptCachingModel(model) {
  return promptCachingMode(model) !== undefined
}

export function withPromptCachingParams(model, params) {
  if (params !== undefined && (typeof params !== "object" || Array.isArray(params))) return params
  const mode = promptCachingMode(model)
  const base = params || {}
  if (mode === "gpt-implicit") {
    return {
      ...base,
      ...(base.prompt_cache_options === undefined
        ? { prompt_cache_options: { mode: "implicit", ttl: "30m" } }
        : {}),
    }
  }
  if (mode === "gpt-retention") {
    return {
      ...base,
      ...(base.prompt_cache_retention === undefined ? { prompt_cache_retention: "24h" } : {}),
    }
  }
  return params
}

export function withPromptCachingMessages(model, messages, opts) {
  if (promptCachingMode(model) !== "claude") return { messages, opts }

  const cachedMessages = [...messages]
  addCacheControlToLast(cachedMessages, "system")
  addCacheControlToLast(cachedMessages, "ai")
  addCacheControlToLast(cachedMessages, "human")

  if (!opts?.tools?.length) return { messages: cachedMessages, opts }
  const tools = [...opts.tools]
  tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: CACHE_CONTROL_EPHEMERAL }
  return { messages: cachedMessages, opts: { ...opts, tools } }
}

export function withPromptCachingOptions(model, opts) {
  const mode = promptCachingMode(model)
  if (mode === "nova" && !opts?.cache_control) {
    return { ...opts, cache_control: CACHE_CONTROL_EPHEMERAL }
  }
  if (!isGptCachingMode(mode)) return opts

  const params = opts?.[PROMPT_CACHE_MODEL_PARAMS] || {}
  if (params.prompt_cache_key !== undefined) return opts
  return {
    ...opts,
    [PROMPT_CACHE_MODEL_PARAMS]: {
      ...params,
      prompt_cache_key: opts?.prompt_cache_key ?? buildPromptCacheKey(),
    },
  }
}

function buildPromptCacheKey() {
  return cds.context?.tenant || ""
}

function promptCachingMode(model) {
  const name = String(model || "")
  if (/anthropic|claude/i.test(name)) return "claude"
  if (/(?:^|[-_])nova(?:[-_]|$)/i.test(name) || /amazon.*nova/i.test(name)) return "nova"

  const version = gptVersion(name)
  if (!version) return undefined
  if (version.major > 5 || (version.major === 5 && version.minor >= 6)) return "gpt-implicit"
  if ((version.major === 5 && version.minor < 6) || (version.major === 4 && version.minor === 1)) {
    return "gpt-retention"
  }
}

function isGptCachingMode(mode) {
  return mode === "gpt-implicit" || mode === "gpt-retention"
}

function gptVersion(model) {
  const match = model.match(/(?:^|[^a-z0-9])gpt[-_]?([0-9]+)(?:[._-]([0-9]+))?/i)
  return match && { major: Number(match[1]), minor: Number(match[2] || 0) }
}

function addCacheControlToLast(messages, type) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messageType(messages[index]) === type && hasTextContent(messages[index])) {
      messages[index] = withCacheControl(messages[index])
      return
    }
  }
}

function messageType(message) {
  return message._getType?.() || message.type
}

function hasTextContent(message) {
  return (
    (typeof message.content === "string" && message.content.length > 0) ||
    (Array.isArray(message.content) &&
      message.content.some((block) => block?.type === "text" && block.text?.length > 0))
  )
}

function withCacheControl(message) {
  const content = message.content
  if (typeof content === "string") {
    return cloneMessage(message, [
      { type: "text", text: content, cache_control: CACHE_CONTROL_EPHEMERAL },
    ])
  }
  if (!Array.isArray(content)) return message

  for (let index = content.length - 1; index >= 0; index--) {
    if (content[index]?.type === "text") {
      const nextContent = [...content]
      nextContent[index] = { ...nextContent[index], cache_control: CACHE_CONTROL_EPHEMERAL }
      return cloneMessage(message, nextContent)
    }
  }
  return message
}

function cloneMessage(message, content) {
  return Object.assign(Object.create(Object.getPrototypeOf(message)), message, { content })
}
