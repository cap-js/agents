import cds from "@sap/cds"
import { createHash } from "node:crypto"
import { join, relative } from "node:path"
import { getMlflowExporter } from "./exporter/index.js"
import { resolveAgentDir } from "../../utils/markdown.js"
import { resolveExperimentId } from "./credentials.js"

const _cache = new Map() // promptName → { version, hash }

// Register or reuse the prompt version in MLflow. Cache hit skips all I/O.
export async function syncPromptVersion(name, template) {
  const exporter = getMlflowExporter()
  if (!exporter) return null

  const hash = hashPrompt(template)
  const cached = _cache.get(name)
  if (cached?.hash === hash) return { name, version: cached.version }

  try {
    const prompt = await exporter.ensurePrompt(name, _description(name), _registrationTags())
    let version
    if (_extractHash(prompt?.latest_versions[0].tags) === hash) {
      version = prompt?.latest_versions[0].version
    } else {
      version = await exporter.createPromptVersion(
        name,
        `Hash ${hash}`,
        _versionTags(template, hash),
        template,
      )
      _linkToExperiment(exporter, name).catch(() => {})
    }
    if (!version) return null
    _cache.set(name, { hash, version })
    return { name, version }
  } catch {
    return null
  }
}

// JSON for mlflow.traceTag.mlflow.linkedPrompts span attribute, or null if not cached.
export function linkedPromptsAttr(promptName) {
  const cached = _cache.get(promptName)
  if (!cached) return null
  return JSON.stringify([{ name: promptName, version: cached.version }])
}

// Extracts the SystemMessage from prepared LLM messages and syncs it to MLflow.
// Cache in syncPromptVersion makes repeated calls a no-op when text is unchanged.
export function syncSystemPrompt(messages) {
  if (!cds.env.agents?.mlflow) return
  const srvName = cds.context?.["agent.service"]
  if (!srvName) return
  const sysMsg = messages?.find((m) => m.type === "system")
  if (!sysMsg) return
  const text =
    typeof sysMsg.content === "string"
      ? sysMsg.content
      : Array.isArray(sysMsg.content)
        ? sysMsg.content
            .filter((b) => b?.type === "text")
            .map((b) => b.text ?? "")
            .join("")
        : null
  if (!text) return
  const srv = cds.services[srvName]
  if (!srv) return
  syncPromptVersion(resolvePromptName(srv), text).catch(() => {})
}

// AGENTS.md path relative to cds.root, or srv.name when no AGENTS.md exists.
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

function _description(name) {
  return `System prompt for CAP agent service "${name.split("/")[0]}"`
}

function _registrationTags() {
  return [{ key: "mlflow.prompt.is_prompt", value: "true" }]
}

function _versionTags(template, hash) {
  return [
    { key: "mlflow.prompt.is_prompt", value: "true" }, // triggers prompt path on server → allows dummy-source
    { key: "mlflow.prompt.text", value: template },
    { key: "_mlflow_prompt_type", value: "text" },
    { key: "_cap_prompt_hash", value: hash },
  ]
}

function _extractHash(tags) {
  return tags?.find((t) => t.key === "_cap_prompt_hash")?.value ?? null
}

// Mirror Python SDK's _link_prompt_to_experiment: append experiment ID to the
// "_mlflow_experiment_ids" tag (comma-wrapped) so the prompt appears in the
// UI's prompts tab for that experiment.
async function _linkToExperiment(exporter, name) {
  const experimentId = resolveExperimentId()
  if (!experimentId) return
  const current = await exporter.getRegisteredModelTag(name, "_mlflow_experiment_ids")
  const ids = current
    ? current
        .replace(/^,|,$/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : []
  if (ids.includes(String(experimentId))) return
  ids.push(String(experimentId))
  await exporter.setRegisteredModelTag(name, "_mlflow_experiment_ids", `,${ids.join(",")},`)
}
