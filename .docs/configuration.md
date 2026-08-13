# Configuration

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

## Advanced Configuration

**Global**

| Setting                          | Description                                                                | Default                  |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------ |
| `cds.agents.contentFilter`       | Content filter (`true` = Azure defaults, object = custom, `false` = off)   | `true`                   |
| `cds.agents.pushNotifications`   | Push notifications (`true` = enabled, `false` = disabled, object = config) | `true`                   |
| `cds.agents.mlflow`              | MLflow tracing (`true` or `false`)                                         | `false`                  |
| `cds.agents.per_action_tool`     | One tool per action (vs combined `call`)                                   | `true`                   |
| `cds.agents.trace_langchain`     | Monkey-patch LangChain for tracing                                         | `true`                   |
| `cds.agents.activeUsersInterval` | Schedule for `active_users` metric computation                             | `"24h"` (`0` to disable) |
| `cds.agents.fileIO.enabled`      | Enable A2A file uploads + emissions (see below)                            | `false`                  |

**Per service**

Path-valued annotations are resolved relative to the `.cds` source file.

| Annotation         | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| `@agent.directory` | Path to the agent directory (overrides the slug convention). |
| `@agent.card`      | Path to a hand-crafted agent card markdown file.             |

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

## Executor Profiles

Only available when agentifying existing services with `@agent` annotation.

- **`development`** - Mock LLM.
- **`hybrid` / `production`** - LangGraph ReAct agent with AI Core.

## File I/O

Set `cds.agents.fileIO.enabled = true` to let agents receive uploads and emit files via the A2A protocol.

```jsonc
{
  "cds": {
    "agents": {
      "fileIO": {
        "enabled": true,
        "maxOutputFileSizeBytes": 10485760, // 10 MB cap per emitted file
        "defaultInputModes": ["text/csv"], // overrides advertised MIME types
        "defaultOutputModes": ["text/plain"],
      },
    },
  },
}
```

Sending a file - A2A clients send a `FilePart` (`{ kind: "file", file: { name, mimeType, bytes } }`) and the plugin persists the file and prepends a `[Uploaded files: /uploads/<name> (<mime>, <size>)]` manifest to the user message. It uses `@cap-js/attachments` to persist the files.

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
