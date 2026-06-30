# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 0.1.0 - TBD

### Added

- Initial project setup as a CDS plugin
- Agent Card compilation during runtime and design time
  - Customize the agent card URL with `@Core.Links` annotated to the service
- Agent protocol adapter that converts incoming requests into LangGraph execution
- Langgraph Executor with AI Core integration to agentify CAP services
- Mock Executor for testing purposes
- Multi-turn conversations with checkpointing
- Option to overwrite the ootb executor
- OpenTelemetry spans for langChain workflows and nodes as well as LLM invocations and tool calls.
- OpenTelemetry metrics for LLM token consumption, tool invocations, agent requests, request duration, errors, concurrent executions and completed workflows as well as agent_actions (per agent node invocation / LLM call) & active_users
- Quota enforcement via `cds.agents.pool` to restrict the amount of tokens consumed, tasks run, Tool calls, max message length send by the client and LLM calls being made (via conditional node for StateGraph agents and middleware for Markdown agents).
- Immutable audit trail via `@cap-js/audit-logging` recording agent decisions, tool invocations, task lifecycle events, and quota breaches as SecurityEvents for forensic analysis and replay
- Circuit breaker and per-call timeout for LLM requests via `@sap-cloud-sdk/resilience`. Configurable timeout via `cds.agents.pool.maxLLMCallTimeoutMs` (default 30s).
- Content filtering with Azure Content Safety prompt injection shield via `cds.agents.contentFilter` (default: `true`) via middleware. Per-service override via `buildContentFilter` event handler. Works for MD and react agents.
- Support export to MLFlow via `cds.agents.mlflow`. By default disabled. Exporter credentials are read from `cds.env.requires["databricks-mlflow"]`.
- Agent Tasks and Checkpoints can only be accessed by the user who created it
- `configMapper` option on `GraphExecutor` to inject request-scoped data into `config.configurable` before `graph.invoke()`.
- Custom tools override via `buildTools` event handler. Results are automatically instrumented via an after handler and in `buildGraph`
- Feature-toggled agent graphs: FIFO cache keyed by `cds.context.features` hash, lazy init on first request. Configure max cache size via `cds.agent.graphCacheSize` (default 20).
- Markdown-based agents auto-built by convention: a `@agent` service with a sibling directory matching the slugified service name (containing `AGENTS.md`) becomes a deep agent — no `.js` handler required. Tools, model, content-filter recovery middleware, and checkpoint persistence are wired automatically.
  - Tools marked with `@UI.IsActionCritical` are automatically considered for human-in-the-loop
  * `@agent.directory` and `@agent.card` annotations to override the convention with explicit paths to the agent directory and the agent card markdown file.
- Declarative MCP server connections via `@agent.mcps` annotation. Declare connections in `cds.requires` and annotate services with `@agent.mcps: [{ service: 'MyMCP' }]` — no manual wiring needed. Supports BTP destinations and Cloud SDK auth token exchange.
- CDS-native file I/O for agents via `cds.agents.fileIO.enabled = true`. Incoming `FilePart` bytes are persisted to `cap.agent.Tasks.inputFiles` (composition of `@cap-js/attachments`) and injected into the LLM context as a file manifest. The default LangGraph path gains `read_file` and `emit_file_part` tools; deep agents wire `UploadsBackend` and `OutputsBackend` into their `CompositeBackend`. Output files written via the agent (`emit_file_part` or `/outputs/` writes) are collected and published as A2A artifacts after graph completion, capped per-file at `cds.agents.fileIO.maxOutputFileSizeBytes` (default 10 MB). Advertised MIME types are merged into the Agent Card's `defaultInputModes` / `defaultOutputModes`.
- Agent preview UI at `/<service-endpoint>/preview` for agents, with a back button to the CDS index page. The preview UI is served from `lib/ui/chat.html` and is injected with the agent name.

### Changed

### Fixed

- Replace `res.set()` with `res.setHeader()` in CORS middleware for compatibility with native Node.js HTTP response objects
- Replace `res.status(204).end()` with `res.writeHead(204)` / `res.end()` to avoid Express-specific API usage

### Removed
