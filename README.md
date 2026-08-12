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
[...]
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

### Agentify Existing CAP Services

Add `@agent` to any CDS service. The plugin auto-generates tools from entities and actions, creates a ReAct agent loop, and serves the service as a remote agent with zero code required. The agent has access to the tools generated from the service model.

```cds
@agent
service CatalogService {
  entity Books as projection on my.Books;
  action submitOrder(book: Books:ID, quantity: Integer) returns { stock: Integer };
}
```

### Markdown-Based Agents

Define an agent's identity, behaviour, and skills entirely in markdown — no JavaScript handler required. Annotate the CDS service with `@agent` and create a sibling directory matching the slugified service name. The plugin auto-builds the agent at startup.

```cds
// srv/cat-service.cds
[...]

// @agent.hitl > Action is considered for Human-in-the-loop
annotate CatalogService.submitOrder with @agent.hitl;
```

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

| Kind        | Description                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `aicore`    | The default for `production` and `hybrid`, connects to SAP AI Core                                                                      |
| `mock`      | The default for `development`, provides a mocked response when called                                                                   |

#### Using Multiple Models (Experimental!)

To use multiple models for different agents, you can define additional ones and reference them via annotation.
When defining an additional model, you need to prefix the kind with `llm-`.

```jsonc
{
  "cds": {
    "requires": {
      "small-llm": {
        // use any name you like
        "kind": "llm-aicore",
        "model": "mistralai--mistral-small",
      },
    },
  },
}
```

```cds
@agent
@agent.llm: 'small-llm'
service CatalogService { ... }
```

| Annotation   | Description                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- |
| `@agent.llm` | LLM service name from `cds.requires` for a single service. Overrides the default (`"llm"`). |



## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/agents/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Security / Disclosure

If you find any bug that may be a security problem, please follow the instructions found [in our security policy](https://github.com/cap-js/agents/security/policy) on how to report it. Please do not create GitHub issues for security-related doubts or problems.

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md) at all times.

## Licensing

Copyright 2026 SAP SE or an SAP affiliate company and cap-js/mcp contributors. Please see our [LICENSE](./LICENSES/Apache-2.0.txt) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/agents).
