# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 0.9.7 - tbd

### Added

- CAP query result fields which are marked as containing personal data will be masked for the LLM, that the LLM works with hashes
- Incoming user messages are pseudonymized using SAP Data Privacy Integration service as well as HANA Cloud NLP
- Chat preview queues messages submitted while the agent is busy

### Fixed

- Chat preview keeps the message field height stable when typing the first character
- Correct lookup for `@agent.directory` and `@agent.card` on BTP
- `triggerCleanup` now uses a unique outbox job name per invocation, preventing the scheduled cleanup job from being silently replaced when a fresh instance starts or the 24h throttle expires

## Version 0.9.6 - 2026-09-17

### Fixed

- Reuse entity filter logic from `@cap-js/mcp` for consistent behavior with Compositions

## Version 0.9.5 - 2026-09-16

### Added

- Two new metrics about HITL reporting for which tools HITL was enforced and how the user decided
- Remote MCP connections support `mcp.tools` in `cds.requires` to restrict which tools are exposed to the agent

### Changed

- Instead of failing when the agent reaches the maximum execution time, a HITL message is thrown asking the user whether to continue
- Renamed config option `cds.agents.pool` to `cds.agents.quotas`

### Fixed

- Services with `@protocol: 'agent'` now also register `@agent` specific handlers
- Mask apiKey in debug logs read from claude / opencode settings
- Adjusted error message to be more accurate
- Prompts are now correctly uploaded to MLFlow for markdown-based agents
- `Judge.evaluate()` assessments now also appear in Databricks UC MLflow
- Propagate opentelemetry traceparent to subagents

## Version 0.9.4 - 2026-09-10

### Added

- Data parts can now be emitted based on tool output

### Fixed

- Multiple tools with HITL needed in the same round no longer cause an error
- Better message to the LLM on HITL rejection
- Remote A2A response does not yield duplicate content
- Added `cds.folders.srvs` to support adjacent agent markdowns ootb.
- Resets quota counter correctly between tasks for task related quota

## Version 0.9.3 - 2026-09-04

### Added

- Added evaluation helpers & MLFlow integration to test the agents behaviour & functional correctness
- Debug logs for tool calls

### Changed

- Adjusted agent audit log attributes to follow latest recommendations
- LLM timeout, retry and circuit-breaker resilience now use a zero-dependency Node-native implementation instead of `@sap-cloud-sdk/resilience`
- Prompt caching is now applied when GPT models are used (previously it was only applied with anthropic models)

### Fixed

- A2A agent card advertises `https://` instead of `http://` when deployed behind a cloud reverse proxy (CF, BTP, Kyma) by reading `X-Forwarded-Proto`
- No longer emits orphaned spans during graph creation
- Fixed remote MCP connections with authenticated server cards

## Version 0.9.2 - 2026-08-26

### Added

- `cds.agents.retention` (default 30d) to configure retention of Tasks and related assets stored for A2A and the agent
- Outgoing MCP and A2A connections now consider `credentials.path` together with the destination
- Added additional OpenTelemetry span attributes detailing how many content filters were active
- Thinking steps are shown in the preview

### Fixed

- Fixed skill loading for markdown-based agents

## Version 0.9.1 - 2026-08-14

### Added

- Initial release
