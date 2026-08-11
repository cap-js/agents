/**
 * Test-only service: verifies that `@agent.model` annotation overrides the
 * global `cds.env.agents.llm` config for per-service model selection.
 *
 * Not a deep-agent (no agent dir / AGENTS.md). Used purely to assert the
 * resolveModelName() resolution chain at the service definition level.
 */
@agent
@agent.llm: 'llm2'
service LlmOverrideService {
  // Empty service body — only the annotation is under test.
}
