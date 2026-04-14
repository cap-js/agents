const cds = require("@sap/cds")
const { DynamicStructuredTool } = require("@langchain/core/tools")
const {
  createGenericReadToolDefinition,
  createDescribeToolDefinition,
  createCallActionToolDefinition,
  createPerActionToolDefinition,
  executeGenericReadTool,
  executeDescribe,
  executeCallActionTool,
  executePerActionTool,
} = require("@cap-js/mcp/lib/tools")
const { checkAuthorization } = require("@cap-js/mcp/lib/auth")

/**
 * Generate LangChain tools from a CDS service.
 *
 * Reuses tool definitions and execution logic from @cap-js/mcp,
 * wrapped as LangChain DynamicStructuredTool instances.
 *
 * @param {object} srv - CDS service instance
 * @returns {{ tools: DynamicStructuredTool[], toolMap: Record<string, DynamicStructuredTool> }}
 */
function generateTools(srv) {
  const { entities, actions, error } = checkAuthorization(srv)
  if (error) return { tools: [], toolMap: {} }

  const tools = []
  const toolMap = {}

  function register(tool) {
    tools.push(tool)
    toolMap[tool.name] = tool
  }

  // Query tool — one tool for reading all entities
  const entityNames = Object.keys(entities)
  if (entityNames.length > 0) {
    const def = createGenericReadToolDefinition(entityNames, srv.name)
    register(
      new DynamicStructuredTool({
        name: def.name,
        description: def.description,
        schema: def.inputSchema,
        func: async (args) => {
          const result = await executeGenericReadTool(srv, entities, args)
          return result.content[0].text
        },
      }),
    )
  }

  // Describe tool — introspect service model
  const actionNames = Object.keys(actions)
  if (entityNames.length > 0 || actionNames.length > 0) {
    const def = createDescribeToolDefinition(entityNames, actionNames, srv.name)
    register(
      new DynamicStructuredTool({
        name: def.name,
        description: def.description,
        schema: def.inputSchema,
        func: async (args) => {
          const result = await executeDescribe(srv, entities, actions, args)
          return result.content[0].text
        },
      }),
    )
  }

  // Action/function tools — per-action (default) or combined call_action
  const usePerActionTools = cds.env.a2a?.per_action_tool !== false
  if (actionNames.length > 0) {
    if (usePerActionTools) {
      for (const [name, action] of Object.entries(actions)) {
        const def = createPerActionToolDefinition(name, action, srv.name)
        register(
          new DynamicStructuredTool({
            name: def.name,
            description: def.description,
            schema: def.inputSchema,
            func: async (args) => {
              const result = await executePerActionTool(srv, name, action, args)
              return result.content[0].text
            },
          }),
        )
      }
    } else {
      const def = createCallActionToolDefinition(actionNames, srv.name)
      register(
        new DynamicStructuredTool({
          name: def.name,
          description: def.description,
          schema: def.inputSchema,
          func: async (args) => {
            const result = await executeCallActionTool(srv, actions, args)
            return result.content[0].text
          },
        }),
      )
    }
  }

  return { tools, toolMap }
}

module.exports = { generateTools }
