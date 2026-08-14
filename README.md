[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/agents)](https://api.reuse.software/info/github.com/cap-js/agents)

# SAP Cloud Application Programming Model, agent development plugin for Node.js

## About this project

CDS plugin for building agents based on the [A2A](https://a2a-protocol.org) protocol.

## Requirements and Setup

We use the [@capire/bookshop](https://github.com/capire/bookshop) as a running sample hereinafter. Clone it and open it in VSCode as follows:

```bash
git clone https://github.com/capire/bookshop
code bookshop
```

Within your project root run this to add the plugin:

```bash
npm add @cap-js/agents
```

Annotate the `CatalogService` with `@agent`:

```cds
// srv/cat-service.cds
...
annotate CatalogService with @agent;
```

Start your server with `cds watch` and note that the A2A protocol gets served:

```bash
[cds] - serving CatalogService {
  at: [ ..., '/a2a/browse' ],
  ...
}
```

For local development, the plugin serves a chat preview at `http://localhost:4004/a2a/browse/preview/` and features a mock LLM.
To use a real LLM, simply bind your app to an existing instance of SAP AI Core and start your server in `hybrid` profile:

```bash
cds bind -2 <instance>
cds w --profile hybrid
```

See [SAP AI Core → Create a Service Instance](https://help.sap.com/docs/sap-ai-core/sap-ai-core-service-guide/create-service-instance) for how to create an instance.

## Ways to Build Agents

Both approaches start from a CDS service annotated with `@agent` (as shown in [Requirements and Setup](#requirements-and-setup)). They differ only in how the agent's behaviour is defined.

### Agentify Existing CAP Services

With `@agent` alone, the plugin auto-generates tools from the service's entities and actions, creates a ReAct agent loop, and serves it as a remote agent — no code required.

```cds
@agent
service CatalogService {
  entity Books as projection on my.Books;
  action submitOrder(book: Books:ID, quantity: Integer) returns { stock: Integer };
}
```

### Markdown-Based Agents

To define an agent's identity, behaviour, and skills explicitly, add a sibling directory matching the slugified service name. When present, it replaces the default agentification: instead of the auto-generated ReAct agent, the plugin auto-builds the agent from the directory at startup — no JavaScript handler required.

```
srv/
├─ cat-service.cds
└─ catalog-agent/                ← matches the slugified service name
   ├─ AGENTS.md                  ← agent identity + behaviour
   └─ skills/
      └─ book-purchase/
         └─ SKILL.md             ← workflow + examples
```

`AGENTS.md` defines who the agent is. The frontmatter populates the agent card;
the body is the agent's system prompt:

```md
---
name: catalog-agent
version: "1.0.0"
description: >
  Bookshop assistant for placing book orders on behalf of the user.
---

# Catalog Agent

## Identity

You are the **Catalog Agent**, a helpful assistant for the capire bookshop.
...
```

## Human-in-the-Loop

Annotate a CDS action with `@agent.hitl` to require human approval before the agent may execute it. When the agent decides to call the action, the task pauses and transitions to the A2A [`input-required`](https://a2a-protocol.org/latest/specification/#413-taskstate) state instead of running the action immediately.

```cds
// srv/cat-service.cds
...
annotate CatalogService.submitOrder with @agent.hitl;
```

## Configuration

The LLM used by an agent is configured via `cds.requires.llm`. You can provide a `kind` as with [any required service](https://cap.cloud.sap/docs/node.js/core-services#required-services).

```jsonc
"cds": {
  "requires": {
    "llm": {
      "kind": "aicore",
      "model": "anthropic--claude-4.6-sonnet"
    }
  }
}
```

| Kind     | Description                                                           |
| -------- | --------------------------------------------------------------------- |
| `aicore` | The default for `production` and `hybrid`, connects to SAP AI Core    |
| `mock`   | The default for `development`, provides a mocked response when called |

## Advanced

The following capabilities are experimental and documented separately. Their public surface may change.

- [Connectivity](.docs/connectivity.md) — destination-based connectivity, `AICORE_SERVICE_KEY` / `ANTHROPIC_API_KEY`, and the `anthropic` kind
- [Configuration](.docs/configuration.md) — using multiple models, global and per-service settings, file I/O, and push notifications
- [Quota Enforcement](.docs/quota.md) — configurable rate limits and resource quotas
- [Audit Logging](.docs/audit-logging.md) — immutable audit trail of agent decisions and tool usage
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
