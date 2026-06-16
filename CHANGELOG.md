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
- OpenTelemetry metrics for LLM token consumption, tool invocations, agent requests, request duration, errors, concurrent executions and completed workflows as well as agent_actions & active_users
- Quota enforcement via `cds.agent.pool` to restrict the amount of tokens consumed, tasks run, Tool calls, max message length send by the client and LLM calls being made.
- Immutable audit trail via `@cap-js/audit-logging` recording agent decisions, tool invocations, task lifecycle events, and quota breaches as SecurityEvents for forensic analysis and replay
- Circuit breaker and per-call timeout for LLM requests via `@sap-cloud-sdk/resilience`. Configurable timeout via `cds.agent.pool.maxLLMCallTimeoutMs` (default 30s).
- Content filtering with Azure Content Safety prompt injection shield via `cds.agent.contentFilter` (default: `true`). Supports per-service override via `this.agent = { contentFilter }` (async function, object, or `false` to disable).
- Support export to MLFlow via `cds.agent.mlflow`. By default disabled. Exporter credentials are read from `cds.env.requires["databricks-mlflow"]`.
- Agent Tasks and Checkpoints can only be accessed by the user who created it
- `configMapper` option on `GraphExecutor` (`this.agent = { graph, configMapper }`) to inject request-scoped data into `config.configurable` before `graph.invoke()`. Enables use cases such as supplying uploaded file capabilities to deepagents' `CapabilityBackend` via LangGraph's `getConfig()` AsyncLocalStorage. The mapper is `await`ed, so async implementations work correctly. Reserved keys (`thread_id`, `_taskId`, `_service`) always take precedence over mapper output. Non-object return values fail the task with a clear error.
- Custom tools override via `this.agent = { tools }`
- Markdown-based agents auto-built by convention: a `@agent` service with a sibling directory matching the slugified service name (containing `AGENTS.md`) becomes a deep agent — no `.js` handler required. Tools, model, content-filter recovery middleware, and checkpoint persistence are wired automatically.
  - Tools marked with `@UI.IsActionCritical` are automatically considered for human-in-the-loop
  * `@agent.directory` and `@agent.card` annotations to override the convention with explicit paths to the agent directory and the agent card markdown file.

### Changed

### Fixed

- Replace `res.set()` with `res.setHeader()` in CORS middleware for compatibility with native Node.js HTTP response objects
- Replace `res.status(204).end()` with `res.writeHead(204)` / `res.end()` to avoid Express-specific API usage

### Removed
