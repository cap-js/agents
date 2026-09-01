import cds from "@sap/cds"
import { createHash } from "node:crypto"
import { join, relative } from "node:path"
import { getMlflowExporter } from "./exporter/index.js"
import { resolveAgentDir } from "../../utils/markdown.js"

const LOG = cds.log("agents")

// Tag keys owned by the prompt domain.
const IS_PROMPT_TAG = "mlflow.prompt.is_prompt"

// promptName → { version: string, hash: string }
const _cache = new Map()

// Register or reuse the prompt version in MLflow. Cache hit (same hash) skips all I/O.
// Returns { name, version } or null when MLflow is off / credentials missing.
export async function syncPromptVersion(name, template) {
  const exporter = getMlflowExporter()
  if (!exporter) return null

  const hash = hashPrompt(template)
  const cached = _cache.get(name)
  if (cached?.hash === hash) return { name, version: cached.version }

  try {
    const description = _promptDescription(name)
    await exporter.ensurePrompt(name, description, _registrationTags())
    const latest = await exporter.getLatestPromptVersion(name)
    const version = _extractHash(latest?.tags) === hash
      ? latest.version
      : await exporter.createPromptVersion(name, `Hash ${hash}`, _versionTags(template, hash), template)

    if (!version) return null
    _cache.set(name, { hash, version })
    return { name, version }
  } catch {
    return null
  }
}

export function linkedPromptsAttr(promptName) {
  const cached = _cache.get(promptName)
  if (!cached) return null
  return JSON.stringify([{ name: promptName, version: cached.version }])
}

export function syncSystemPrompt(messages) {
  if (!cds.env.agents?.mlflow) return
  const srvName = cds.context?.["agent.service"]
  if (!srvName) return
  const sysMsg = messages?.find((m) => m.type === "system")
  if (!sysMsg) return
  const text = typeof sysMsg.content === "string"
    ? sysMsg.content
    : Array.isArray(sysMsg.content)
      ? sysMsg.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("")
      : null
  if (!text) return
  const srv = cds.services[srvName]
  if (!srv) return
  syncPromptVersion(resolvePromptName(srv), text).catch(() => {})
}

// AGENTS.md path relative to cds.root (e.g. "srv/catalog-agent/AGENTS.md"),
// or srv.name when no AGENTS.md exists.
export function resolvePromptName(srv) {
  if (!srv?.name) return ""
  const agentDir = resolveAgentDir(srv)
  if (!agentDir) return srv.name
  const root = cds.root ?? process.cwd()
  return relative(root, join(agentDir, "AGENTS.md")).replace(/\\/g, "/")
}

export function hashPrompt(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

export function getCachedPromptVersion(name) {
  return _cache.get(name) ?? null
}

function _promptDescription(name) {
  return `System prompt for CAP agent service "${name.split("/")[0]}"`
}

function _registrationTags() {
  return [{ key: IS_PROMPT_TAG, value: "true" }]
}

function _versionTags(template, hash) {
  return [
    { key: "mlflow.prompt.text", value: template },
    { key: "_mlflow_prompt_type", value: "text" },
    { key: "_cap_prompt_hash", value: hash },
    { key: "_cap_prompt_type", value: "system prompt" },
  ]
}

function _extractHash(tags) {
  return tags?.find((t) => t.key === PROMPT_HASH_TAG)?.value ?? null
}
