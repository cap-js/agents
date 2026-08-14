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

**Per-service override:**

Define a dedicated LLM service in `cds.requires` and set its `contentFilter`, then bind a service to it via [`@agent.llm`](./configuration.md#using-multiple-models):

```json
{
  "cds": {
    "requires": {
      "safe-llm": {
        "kind": "aicore",
        "contentFilter": {
          "input": { "azure_content_safety": { "prompt_shield": true, "hate": "ALLOW_SAFE" } },
          "output": { "azure_content_safety": { "hate": "ALLOW_SAFE" } }
        }
      }
    }
  }
}
```

To disable filtering for a single service, use `"contentFilter": false` in that service's LLM entry.

**Resolution order:** `cds.requires.<llmName>.contentFilter` (per-service, inherits from `kinds.<kind>` via CDS) → package default (`kinds.aicore.contentFilter: true` → Azure Content Safety with `hate=ALLOW_SAFE_LOW`, `violence=ALLOW_SAFE_LOW_MEDIUM`, `prompt_shield=true` for input; `hate=ALLOW_SAFE`, `violence=ALLOW_SAFE_LOW_MEDIUM` for output).

</details>
