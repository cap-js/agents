# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 0.9.3 - tbd

### Fixed

- Fixed remote MCP connections with authenticated server cards

### Added

- Debug logs for tool calls

### Fixed

- A2A agent card advertises `https://` instead of `http://` when deployed behind a cloud reverse proxy (CF, BTP, Kyma) by reading `X-Forwarded-Proto`

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
