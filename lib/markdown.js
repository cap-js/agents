import cds from "@sap/cds"
const { path, fs } = cds.utils

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
