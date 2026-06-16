import cds from "@sap/cds"
const { path, fs } = cds.utils
const LOG = cds.log("agent")

/**
 * Mirrors CAP's internal slug rules used for service path generation.
 */
export const slugified = (name) =>
  /[^.]+$/
    .exec(name)[0]
    .replace(/Service$/, "")
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, (_m, c, C) => c + "-" + C)
    .toLowerCase()

/**
 * Absolute filesystem directory of the `.cds` source file that defines `srv`.
 */
export function serviceSourceDir(srv) {
  const file = srv?.definition?.$location?.file
  if (!file) return undefined
  // $location.file is relative to cds.root
  return path.dirname(path.join(cds.root, file))
}

/**
 * Resolve a path from a `@agent.directory` / `@agent.card` annotation against the
 * `.cds` source file's directory. Absolute paths are returned as-is.
 */
function resolveAnnotatedPath(srv, annotationValue) {
  if (!annotationValue || typeof annotationValue !== "string") return undefined
  if (path.isAbsolute(annotationValue)) return annotationValue
  const srcDir = serviceSourceDir(srv)
  if (!srcDir) return undefined
  return path.resolve(srcDir, annotationValue)
}

/**
 * Resolve the agent directory for a service.
 *
 * Resolution order:
 *   1. `@agent.directory` annotation (relative to `.cds` source file dir, or absolute)
 *   2. Slugified service-name convention: `<srcDir>/<slugified(srv.name)>/`
 *   3. `undefined`
 */
export function resolveAgentDir(srv) {
  const annotated = resolveAnnotatedPath(srv, srv?.definition?.["@agent.directory"])
  if (annotated) {
    if (fs.existsSync(annotated)) return annotated
    LOG.warn("@agent.directory path not found, falling back to convention", {
      service: srv?.name,
      annotation: srv?.definition?.["@agent.directory"],
      resolved: annotated,
    })
    return undefined
  }
  const srcDir = serviceSourceDir(srv)
  if (!srcDir) return undefined
  const conventional = path.join(srcDir, slugified(srv.name))
  if (fs.existsSync(conventional)) return conventional
  return undefined
}

/**
 * Resolve an explicit agent-card markdown file via `@agent.card` annotation.
 * Returns `undefined` when no annotation is set; falls through to the
 * agent-dir-based resolution chain (`AGENT_CARD.md` → `skills/`) handled by
 * the card builder.
 */
export function resolveAgentCardPath(srv) {
  return resolveAnnotatedPath(srv, srv?.definition?.["@agent.card"])
}

/**
 * `<dir>/AGENTS.md` exists ⇒ this is a deep-agent directory.
 */
export function isDeepAgentDir(dir) {
  if (!dir) return false
  return fs.existsSync(path.join(dir, "AGENTS.md"))
}

/**
 * Parse YAML frontmatter from a markdown file.
 */
export function parseFrontmatter(filePath) {
  let content
  try {
    content = fs.readFileSync(filePath, "utf8")
  } catch {
    return null
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return null

  try {
    const { yaml } = cds.utils
    return yaml.parse(match[1])
  } catch {
    // Fallback: return null if YAML parsing fails
    return null
  }
}

/**
 * Scan a skills directory and return skill metadata for the agent card.
 * Reads SKILL.md frontmatter per agentskills.io spec.
 * Respects metadata.private: true to exclude internal skills.
 *
 * @returns {Array<{id, name, description, tags, examples}>}
 */
export function scanSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return []

  let entries
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md")
    const meta = parseFrontmatter(skillFile)
    if (!meta || !meta.name) continue

    // metadata.private: true → internal skill, not in agent card
    const isPrivate = meta.metadata?.private === "true" || meta.metadata?.private === true
    if (isPrivate) continue

    skills.push({
      id: meta.name,
      name: meta.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      description: (meta.description || "").trim(),
      tags: meta.metadata?.tags || [],
      examples: meta.metadata?.examples || [],
    })
  }

  // Alphabetical sort for deterministic output across filesystems
  return skills.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Parse AGENTS.md frontmatter for agent-level metadata.
 */
export function parseAgentMetadata(agentDir) {
  return parseFrontmatter(path.join(agentDir, "AGENTS.md"))
}

/**
 * Parse AGENT_CARD.md for explicit agent card definition (convention within agentDir).
 */
export function parseAgentCardMd(agentDir) {
  return parseFrontmatter(path.join(agentDir, "AGENT_CARD.md"))
}

/**
 * Parse an agent card markdown file at an explicit absolute path.
 */
export function parseAgentCardFile(absolutePath) {
  return parseFrontmatter(absolutePath)
}
