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
- Quota enforcement via `cds.a2a.pool` to restrict the amount of tokens consumed, tasks run, Tool calls and LLM calls being made.
- Circuit breaker and per-call timeout for LLM requests via `@sap-cloud-sdk/resilience`. Configurable timeout via `cds.a2a.pool.maxLLMCallTimeoutMs` (default 30s).

### Changed

### Fixed

### Removed
