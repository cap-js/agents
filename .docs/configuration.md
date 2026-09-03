# Configuration

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

## Using Multiple Models

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

## Pi executor (proof of concept)

The Pi POC uses a native `@earendil-works/pi-agent-core` loop rather than LangGraph. Enable it
with the `pi` profile. In development it uses the existing `llm-mock` configuration, so it can
be tried without credentials:

```sh
CDS_ENV=development,pi cds watch
```

Combine it with a Pi-supported model provider such as Anthropic for a real model:

```sh
ANTHROPIC_API_KEY=... CDS_ENV=pi,with-claude cds watch
```

It reads the same `llm` (or service-specific `@agent.llm`) entry as the default executor:

```jsonc
{
  "cds": {
    "requires": {
      "llm": {
        "kind": "anthropic",
        "model": "claude-sonnet-4-6"
      },
      "agent-executor": {
        "kind": "agent-executor-pi",
        "thinkingLevel": "off"
      }
    }
  }
}
```

Executor implementations are regular `cds.requires.kinds` entries. LangGraph remains the
default (`agent-executor-langgraph`); `agent-executor-pi` selects Pi. The POC supports Pi model
providers such as Anthropic and adapts the existing CDS-generated tools to Pi tools. LangGraph
features such as checkpoint persistence, HITL interrupts, deep-agent directories, per-run quota
middleware, and output-file collection are not part of the POC. Pi conversation state is kept in
memory per tenant, service, and A2A context.

## `@agent.directory`

Service annotation. Path to the agent directory, overriding the slug convention. Resolved relative to the `.cds` source file.

```cds
@agent
@agent.directory: './catalog-agent'
service CatalogService { }
```

## `@agent.card`

Service annotation. Path to a hand-crafted agent card markdown file. Resolved relative to the `.cds` source file.

```cds
@agent
@agent.card: './catalog-card.md'
service CatalogService { }
```

<details>
<summary>Customize Agent Card URL</summary>

If your agent is behind a proxy, configure the agent card URL via `@Core.Links`

```cds
@agent
@Core.Links : [
  {
      rel : 'via',
      href : 'https://example.com/agent/catalog',
  },
]
service CatalogService { }
```

</details>

## Push Notifications

Agents advertise push notification support via `capabilities.pushNotifications: true` in the agent card. Clients can register a webhook URL to receive task updates as HTTP POST callbacks instead of (or in addition to) SSE streaming.

<details>
<summary>Configuration</summary>

Push notifications are enabled by default. To disable:

```jsonc
{
  "cds": {
    "agents": {
      "pushNotifications": false,
    },
  },
}
```

**Domain allowlist** — restrict which domains are accepted as callback URLs. By default, only `cloud.sap` (and its subdomains) is allowed:

```jsonc
{
  "cds": {
    "agents": {
      "pushNotifications": {
        "allowedDomains": ["cloud.sap", "mycompany.com"],
      },
    },
  },
}
```

When configured, the agent rejects push notification registrations whose callback URL does not match an allowed domain. Subdomains are accepted (e.g. `api.mycompany.com` matches `mycompany.com`). If you need to accept additional domains beyond `cloud.sap`, add them to the `allowedDomains` array.

**IAS authentication** — to attach an IAS bearer token to push notification requests, set `pushNotifications.ias.resource` to the target app name. Requires an SAP Identity service binding; falls back to unauthenticated delivery when unavailable.

```jsonc
{
  "cds": {
    "agents": {
      "pushNotifications": {
        "ias": { "resource": "my-target-app" },
      },
    },
  },
}
```

</details>

## File I/O

Set `cds.agents.fileIO.enabled = true` to let agents receive uploads and emit files via the A2A protocol.

```jsonc
{
  "cds": {
    "agents": {
      "fileIO": {
        "enabled": true,
        "maxInputFileSizeBytes": 2097152,
        "maxOutputFileSizeBytes": 10485760, // 10 MB cap per emitted file
        "defaultInputModes": ["text/csv"], // overrides advertised MIME types
        "defaultOutputModes": ["text/plain"],
      },
    },
  },
}
```

Sending a file - A2A clients send a `FilePart` (`{ kind: "file", file: { name, mimeType, bytes } }`) and the plugin persists the file and prepends a `[Uploaded files: /uploads/<name> (<mime>, <size>)]` manifest to the user message. It uses `@cap-js/attachments` to persist the files.
