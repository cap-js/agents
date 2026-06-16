/**
 * Demonstrates `@a2a.directory` in isolation:
 *   - The slugified service name (`dir-override`) does NOT match the agent
 *     directory (`card-override-agent`); the annotation drives the resolution.
 *   - No `@a2a.card`, so the agent card is built from the dir's AGENTS.md
 *     frontmatter and `skills/` scan — confirming the dir was actually used.
 */
@a2a
@a2a.directory: 'card-override-agent'
service DirOverrideService { }
