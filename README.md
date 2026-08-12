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

See [SAP AI Core -> Create a Service Instance](https://help.sap.com/docs/sap-ai-core/sap-ai-core-service-guide/create-service-instance) for how to create an instance.

## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/agents/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Security / Disclosure

If you find any bug that may be a security problem, please follow the instructions found [in our security policy](https://github.com/cap-js/agents/security/policy) on how to report it. Please do not create GitHub issues for security-related doubts or problems.

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md) at all times.

## Licensing

Copyright 2026 SAP SE or an SAP affiliate company and cap-js/mcp contributors. Please see our [LICENSE](./LICENSES/Apache-2.0.txt) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/agents).
