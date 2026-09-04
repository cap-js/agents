import cds from "@sap/cds"
import { createHash } from "node:crypto"

export const PROMPT_CACHE_MODEL_PARAMS = Symbol("promptCacheModelParams")

const CACHE_CONTROL_EPHEMERAL = { type: "ephemeral" }

export function isPromptCachingModel(model) {
  return (
    isExplicitCacheControlModel(model) ||
    isGpt56OrLater(model) ||
    isGptExtendedRetentionModel(model)
  )
}

export function withPromptCachingParams(model, params) {
  if (params !== undefined && (typeof params !== "object" || Array.isArray(params))) return params
  const base = params || {}
  if (isGpt56OrLater(model)) {
    return {
      ...base,
      ...(base.prompt_cache_options === undefined
        ? { prompt_cache_options: { mode: "implicit", ttl: "30m" } }
        : {}),
    }
  }
  if (isGptExtendedRetentionModel(model)) {
    return {
      ...base,
      ...(base.prompt_cache_retention === undefined ? { prompt_cache_retention: "24h" } : {}),
    }
  }
  return params
}

export function withPromptCachingOptions(model, opts) {
  let result = opts
  if (isExplicitCacheControlModel(model) && !result?.cache_control) {
    result = { ...result, cache_control: CACHE_CONTROL_EPHEMERAL }
  }
  if (isGpt56OrLater(model) || isGptExtendedRetentionModel(model)) {
    const params = result?.[PROMPT_CACHE_MODEL_PARAMS] || {}
    if (!params.prompt_cache_key) {
      const promptCacheKey = result?.prompt_cache_key || buildPromptCacheKey(model, result)
      if (promptCacheKey) {
        result = {
          ...result,
          [PROMPT_CACHE_MODEL_PARAMS]: { ...params, prompt_cache_key: promptCacheKey },
        }
      }
    }
  }
  return result
}

export function buildPromptCacheKey(model, opts) {
  const service = opts?.configurable?._service || cds.context?.["agent.service"] || "agent"
  const tenant = cds.context?.tenant || "anonymous"
  const user = opts?.configurable?._userId || cds.context?.user?.id
  const thread = opts?.configurable?.thread_id || cds.context?.["agent.context.id"]
  const affinity = user || thread
  if (!affinity) return undefined

  const servicePart = _cacheKeyPart(service)
  const modelPart = _cacheKeyPart(model)
  const digest = createHash("sha256").update(`${tenant}:${affinity}`).digest("hex").slice(0, 16)
  return `cap-agents:${servicePart}:${modelPart}:${digest}`
}

function isClaude(model) {
  return /anthropic|claude/i.test(model || "")
}

function isNova(model) {
  return /(?:^|[-_])nova(?:[-_]|$)/i.test(model || "") || /amazon.*nova/i.test(model || "")
}

function isExplicitCacheControlModel(model) {
  return isClaude(model) || isNova(model)
}

function isGpt56OrLater(model) {
  const version = _gptVersion(model)
  if (!version) return false
  return version.major > 5 || (version.major === 5 && version.minor >= 6)
}

function isGptExtendedRetentionModel(model) {
  const version = _gptVersion(model)
  if (!version) return false
  if (version.major === 5 && version.minor < 6) return true
  if (version.major === 4 && version.minor === 1) return true
  return false
}

function _gptVersion(model) {
  const match = String(model || "").match(/(?:^|[^a-z0-9])gpt[-_]?([0-9]+)(?:[._-]([0-9]+))?/i)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2] || 0) }
}

function _cacheKeyPart(value) {
  const part = String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  return part || "unknown"
}
