# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 0.1.0 - TBD

### Added

- Initial project setup as a CDS protocol adapter
- Agent Card compilation during runtime and design time
- A2A Protocol adapter that converts A2A requests into LangGraph execution
- Langgraph Executor with AI Core integration to agentify CAP services
- Mock Executor for testing purposes
- Multi-turn conversations with checkpointing
- Option to overwrite the ootb executor
- OpenTelemetry spans for langChain workflows and nodes as well as LLM invocations and tool calls.
- OpenTelemetry metrics for LLM token consumption, tool invocations, A2A requests, request duration, errors, concurrent executions and completed workflows as well as agent_actions & active_users
- Quota enforcement via `cds.a2a.pool` to restrict the amount of tokens consumed, tasks run, Tool calls, max message length send by the client and LLM calls being made.
- Immutable audit trail via `@cap-js/audit-logging` recording agent decisions, tool invocations, task lifecycle events, and quota breaches as SecurityEvents for forensic analysis and replay
- Circuit breaker and per-call timeout for LLM requests via `@sap-cloud-sdk/resilience`. Configurable timeout via `cds.a2a.pool.maxLLMCallTimeoutMs` (default 30s).
- Content filtering with Azure Content Safety prompt injection shield via `cds.a2a.contentFilter` (default: `true`). Supports per-service override via `this.a2a = { contentFilter }` (async function, object, or `false` to disable).
- A2A Tasks and Checkpoints can only be accessed by the user who created it
- `configMapper` option on `GraphExecutor` (`this.a2a = { graph, configMapper }`) to inject request-scoped data into `config.configurable` before `graph.invoke()`. Enables use cases such as supplying A2A-uploaded file capabilities to deepagents' `CapabilityBackend` via LangGraph's `getConfig()` AsyncLocalStorage. The mapper is `await`ed, so async implementations work correctly. Reserved keys (`thread_id`, `_taskId`, `_service`) always take precedence over mapper output. Non-object return values fail the task with a clear error.
- Custom tools override via `this.a2a = { tools }`

### Changed

### Fixed

### Removed
