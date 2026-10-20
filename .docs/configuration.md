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

## Streaming Tool Updates

A2A clients can opt-in to tool updates via user message metadata when streaming:

```json
{
  "jsonrpc":"2.0",
  "method":"message/stream",
  "id":"...",
  "params": {
    "message": {
      ...
      "metadata": {
        "tool-status-update": { "args":true, "result":true }
      }
    },
  }
}
```

The resulting artifact updates may contain [A2A data parts](https://a2a-protocol.org/v0.3.0/specification/#653-datapart-object) with type `tool-call`, for example:

```json
{
  "artifactId": "...",
  "parts":
    [
      {
        "kind": "data",
        "data":
          {
            "type": "tool-call",
            "name": "sap_capire_flights_flightsservice_describe",
            "kind": "describe",
            "label": "sap.capire.flights.FlightsService",
            "status": "done",
            "args": "...",
            "result": "...",
          },
      },
    ],
},
```

## Status messages

When the agent runs, via A2A status messages are emitted so users know what is happening. The generic messages are:

- `Querying <entity>` for `query` tool calls
- `Inspecting <entity>` for `describe` tool calls
- `Calling <action>` for all other tool calls
- `Processing tool response` when a tool reply is handed over to the LLM

For markdown based agents further messages exist:

- `Delegating work to a subagent` & `Delegating work to multiple subagents` when calling the `task` tool
- Messages that the agent accesses or interacts with its conversation-scoped memory when calling `ls`, `read_file`, `write_file`, `edit_file`, `delete`, `glob` or `grep`.

The status messages for actions can be customized.

```cds
service CatalogAgent {
  entity Books as projection on db.Books;

  @Core.Messages : [
    {
      code: 'agent-status-update',
      message: '{i18n>SUBMIT_ORDER}'
    }
  ]
  action submitOrder(
    @Common.ValueList : {
      CollectionPath: 'Books',
      Parameters: [
        {
          $Type: 'Common.ValueListParameterInOut',
          LocalDataProperty: bookID,
          ValueListProperty: 'ID'
        }
      ]
    }
    bookID: string
  );

  annotate Books with {
    ID @Common.Text: title @Common.TextArrangement: #TextFirst;
  }
}
```

```properties
SUBMIT_ORDER=Submitting your order for {book}
```

With this minimal sample, the message would render as "Submitting your order for Wuthering Heights (201)".

`@Common.Text` accepts path values, all kinds of text arrangement are supported and [`@Common.ExternalID`](https://help.sap.com/docs/ABAP_PLATFORM_NEW/468a97775123488ab3345a0c48cadd8f/f49a0f7eaafe444daf4cd62d48120ad0.html) works as well.
