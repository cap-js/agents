# Content Filter

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

By default, all LLM calls pass through [SAP AI Core content filtering](https://help.sap.com/docs/sap-ai-core/generative-ai/input-filtering) with Azure Content Safety and a prompt injection shield (`cds.requires.kinds.aicore.contentFilter: true`). This blocks prompt injection attacks both from user messages and from tool output (e.g. malicious data in database fields).

<details>
<summary>Configuration options</summary>

**Disable globally:**

```json
{ "cds": { "requires": { "kinds": { "aicore": { "contentFilter": false } } } } }
```

**Custom filter dictionary:**

Azure content safety levels: ALLOW_SAFE -> ALLOW_SAFE_LOW -> ALLOW_SAFE_LOW_MEDIUM -> ALLOW_ALL

```json
{ "cds": { "requires": { "kinds": { "aicore": {
      "contentFilter": {
        "input": {
          "azure_content_safety": {
            "hate": "ALLOW_SAFE_LOW",
            "violence": "ALLOW_SAFE_LOW_MEDIUM",
            "prompt_shield": true
          },
          "llama_guard_3_8b": {
            "violent_crimes": true
          }
        },
        "output": {
          "azure_content_safety": {
            "hate": "ALLOW_SAFE",
            "violence": "ALLOW_SAFE_LOW_MEDIUM"
          }
        }
      }
    }
  }
}
```

**Per-service override** via `buildContentFilter` event handler:

```js
// Disable for one service (return an empty object)
this.on("buildContentFilter", () => ({}))

// Custom filter
this.on("buildContentFilter", () => ({
  input: {
    azure_content_safety: { prompt_shield: true, hate: "ALLOW_SAFE" },
    llama_guard_3_8b: { violent_crimes: true },
  },
  output: {
    azure_content_safety: { hate: "ALLOW_SAFE", violence: "ALLOW_SAFE" },
  },
}))
```
Resolution order: `buildContentFilter` event handler → `cds.env.agents.contentFilter` → default (Azure Content Safety). Return `{}` from the event handler to disable filtering for the service; returning nothing falls through to the global config.

</details>
