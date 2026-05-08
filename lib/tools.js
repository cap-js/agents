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
const { getFilteredEntities, getFilteredActions } = require("./utils")

/**
 * Reuses tool definitions and execution logic from @cap-js/mcp
 *
 * @param {object} srv - CDS ApplicationService
 * @param {object} [options] - Options
 * @param {boolean} [options.skipAuth] - Skip authorization check (e.g. when generating tools at startup for custom graphs)
 */
function generateTools(srv, options = {}) {
  let entities, actions

  // TODO: needs to be done differently
  if (options.skipAuth) {
    entities = getFilteredEntities(srv)
    actions = getFilteredActions(srv)
  } else {
    const authResult = checkAuthorization(srv)
    if (authResult.error) return { tools: [], toolMap: {} }
    entities = authResult.entities
    actions = authResult.actions
  }

  const tools = []
  const toolMap = {}

  function register(dstool) {
    // Wrap invoke to catch schema validation errors that deepagents' ToolNode
    // would otherwise re-throw as MiddlewareErrors (crashing graph.invoke()).
    // By catching here, errors become normal tool results the LLM can learn from.
    const originalInvoke = dstool.invoke.bind(dstool)
    dstool.invoke = async (args, config) => {
      try {
        return await originalInvoke(args, config)
      } catch (err) {
        return `Error: ${err.message}`
      }
    }
    tools.push(dstool)
    toolMap[dstool.name] = dstool
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
