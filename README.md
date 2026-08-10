# SAP Cloud Application Programming Model, agent development plugin for Node.js

## About this project

This is a CDS plugin for building agents in CAP.

## Requirements and Setup

We use the @capire/bookshop as a running sample hereinafter. Clone it and open it in VSCode as follows:

```bash
git clone https://github.com/capire/bookshop
code bookshop
```

Annotate the CatalogService with `@agent`:

```cds
@agent @odata
service CatalogService { ... }
```

## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/agents/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Security / Disclosure

If you find any bug that may be a security problem, please follow the instructions found [in our security policy](https://github.com/cap-js/agents/security/policy) on how to report it. Please do not create GitHub issues for security-related doubts or problems.

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md) at all times.

## Licensing

Copyright 2026 SAP SE or an SAP affiliate company and cap-js/mcp contributors. Please see our [LICENSE](./LICENSES/Apache-2.0.txt) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/agents).
