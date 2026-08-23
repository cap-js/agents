@impl: '@cap-js/agents/lib/agentService.js'
service agents {
  action describe(action: String, entity: String) returns String;
  // REVISIT: it was impossble for qwen3 to use the call tool (therefor action)
  action action(action: String not null, args: Map) returns String;
  action query(cql: String not null)              returns String;
  action skill(name: String not null)             returns String;
}
