# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 0.9.3 - tbd

### Changed

- LLM timeout, retry and circuit-breaker resilience now use a zero-dependency Node-native implementation instead of `@sap-cloud-sdk/resilience`

## Version 0.9.2 - 2026-08-26

### Added

- `cds.agents.retention` (default 30d) to configure retention of Tasks and related assets stored for A2A and the agent
- Outgoing MCP and A2A connections now consider `credentials.path` together with the destination
- Added additional OpenTelemetry span attributes detailing how many content filters were active

### Fixed

- Fixed skill loading for markdown-based agents

## Version 0.9.1 - 2026-08-14

### Added

- Initial release
