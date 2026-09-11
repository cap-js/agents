[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/agents)](https://api.reuse.software/info/github.com/cap-js/agents)

# SAP Cloud Application Programming Model, agent development plugin for Node.js

## About this project

CDS plugin for building agents based on the [A2A](https://a2a-protocol.org) protocol.


## Usage

For detailed instructions about setup and usage, refer to the [official documentation](https://cap.cloud.sap/docs/guides/ai/cap-agents).


## Advanced

The following capabilities are experimental and documented separately. Their public surface may change.

- [Connectivity](.docs/connectivity.md) — destination-based connectivity, `AICORE_SERVICE_KEY` / `ANTHROPIC_API_KEY`, and the `anthropic` kind
- [Configuration](.docs/configuration.md) — using multiple models, global and per-service settings, file I/O, and push notifications
- [Quota Enforcement](.docs/quota.md) — configurable rate limits and resource quotas
- [Audit Logging](.docs/audit-logging.md) — immutable audit trail of agent decisions and tool usage
- [Data Privacy](.docs/data-privacy.md) — deletion of message history
- [Telemetry](.docs/telemetry.md) — OpenTelemetry metrics, tracing, and MLflow export
- [Content Filter](.docs/content-filter.md) — SAP AI Core content filtering and prompt injection shielding

## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/agents/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Security / Disclosure

If you find any bug that may be a security problem, please follow the instructions found [in our security policy](https://github.com/cap-js/agents/security/policy) on how to report it. Please do not create GitHub issues for security-related doubts or problems.

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md) at all times.

## Licensing

Copyright 2026 SAP SE or an SAP affiliate company and cap-js/mcp contributors. Please see our [LICENSE](./LICENSES/Apache-2.0.txt) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/agents).
