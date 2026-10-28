// Condition: @agent.directory points the card builder at a folder whose name
// does NOT match the service slug (external-dir), proving the annotation drives
// the agent-directory resolution rather than the naming convention.

@agent
@agent.directory: '../shared-home'
service ExternalDirService { }
