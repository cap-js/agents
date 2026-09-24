# Connectivity

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

## Connecting to SAP AI Core

Beyond binding a service instance with `cds bind -2 <instance>`, the plugin can reach SAP AI Core in the following ways:

- **`AICORE_SERVICE_KEY` environment variable** — set it to the JSON service key of your AI Core instance. Useful for local development without a binding.
- **BTP Destination** — for a central AI Core instance shared across subaccounts (see [Destination-Based Connectivity](#destination-based-connectivity) below).

When neither a destination nor `AICORE_SERVICE_KEY` is set, the plugin falls back to the standard service binding resolution (`VCAP_SERVICES`).

See [SAP Cloud SDK for AI](https://sap.github.io/ai-sdk/docs/js/connecting-to-ai-core) for details.

## Destination-Based Connectivity

When AI Core is not bound as a service instance but accessible through a BTP Destination (e.g., a central AI Core instance shared across subaccounts), configure `destinationName` in your CDS config:

```jsonc
// package.json or .cdsrc.json
{
  "cds": {
    "requires": {
      "[production]": {
        "llm": {
          "kind": "llm-aicore",
          "destinationName": "my-aicore-destination",
          "resourceGroup": "default",
        },
      },
    },
  },
}
```

| Property          | Description                                      | Default                                   |
| ----------------- | ------------------------------------------------ | ----------------------------------------- |
| `destinationName` | Name of the BTP destination pointing to AI Core  | — (uses service binding)                  |
| `resourceGroup`   | AI Core resource group for deployment resolution | `"default"` (when destinationName is set) |

**BTP Destination setup:**

- Type: HTTP
- URL: `https://<aicore-host>.ml.hana.ondemand.com`
- Authentication: OAuth2ClientCredentials (pointing to AI Core's XSUAA)
- Additional property: `URL.headers.AI-Resource-Group` = `default`

When `destinationName` is omitted, the plugin falls back to the standard service binding resolution (VCAP_SERVICES / `AICORE_SERVICE_KEY`).

## Anthropic Kind (`ANTHROPIC_API_KEY`)

To connect directly to the Anthropic API instead of SAP AI Core, use the `anthropic` kind. It is used in the `with-claude` profile and autodiscovers config based on environment variables (`ANTHROPIC_API_KEY`) or `.claude/settings.json`.

```jsonc
"cds": {
  "requires": {
    "llm": {
      "kind": "anthropic"
    }
  }
}
```

| Kind        | Description                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic` | Used in the `with-claude` profile, autodiscovers config based on environment variables (`ANTHROPIC_API_KEY`) or `.claude/settings.json` |
