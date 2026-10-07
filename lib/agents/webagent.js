import { initializeHistory, toPiTools } from './pi.js'
import { AgentHarness } from "@sap/webagent"

export default async function create(srv) {
  const tools = await srv.send('buildTools')
  const llm = await srv.send('buildModel')
  const systemPrompt = await srv.send('buildSystemPrompt')
  if (!llm?.model || typeof llm.streamFn !== 'function') {
    throw new Error(
      'Pi models must expose a model and streamFn; configure a Pi model kind such as pi-anthropic',
    )
  }

  // AgentHarness's internal shim only supports "openai-completions". The pi-anthropic model uses
  // "anthropic-messages", so we coerce the api field here. The caller must configure baseUrl to
  // point at an OpenAI-compatible proxy (e.g. LiteLLM at http://localhost:6655/litellm/v1) and
  // set modelName to the proxy's expected model ID (e.g. "anthropic/claude-sonnet-4-6" for LiteLLM).
  const model = { ...llm.model, api: "openai-completions" }

  // AgentHarnessConfig has no systemPrompt field — must be patched onto agent.state after construction.
  // authToken must be a static string; AgentHarness does not accept a getter function.
  const authToken = llm.getApiKey ? await llm.getApiKey() : llm.authToken

  const harness = new AgentHarness({
    model,
    authToken,
    tools: toPiTools(tools)
  })

  const { agent } = harness
  initializeHistory(agent)
  if (systemPrompt) agent.state.systemPrompt = systemPrompt
  return agent
}
