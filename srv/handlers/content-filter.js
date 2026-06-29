import cds from "@sap/cds"

const AZURE_THRESHOLDS = {
  ALLOW_SAFE: 0,
  ALLOW_SAFE_LOW: 2,
  ALLOW_SAFE_LOW_MEDIUM: 4,
  ALLOW_ALL: 6,
}

/**
 * Resolve content filter config from cds.env.agents.contentFilter.
 * Returns simplified dictionary or undefined (disabled).
 */
export function buildContentFilter() {
  const config = cds.env.agents.contentFilter
  if (!config) return undefined
  if (typeof config === "object") return config

  return {
    input: {
      azure_content_safety: {
        hate: "ALLOW_SAFE_LOW",
        violence: "ALLOW_SAFE_LOW_MEDIUM",
        prompt_shield: true,
      },
    },
    output: {
      azure_content_safety: {
        hate: "ALLOW_SAFE",
        violence: "ALLOW_SAFE_LOW_MEDIUM",
      },
    },
  }
}

/**
 * Convert simplified dictionary to SDK array format.
 * Azure threshold strings are converted to numeric values.
 */
export function toSdkFilterFormat(filterConfig) {
  if (!filterConfig) return undefined
  const result = {}
  if (filterConfig.input) {
    result.input = {
      filters: Object.entries(filterConfig.input).map(([type, config]) => ({
        type,
        config: convertFilterConfig(type, config),
      })),
    }
  }
  if (filterConfig.output) {
    result.output = {
      filters: Object.entries(filterConfig.output).map(([type, config]) => ({
        type,
        config: convertFilterConfig(type, config),
      })),
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function convertFilterConfig(type, config) {
  if (type !== "azure_content_safety") return config
  const converted = {}
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string" && value in AZURE_THRESHOLDS) {
      converted[key] = AZURE_THRESHOLDS[value]
    } else {
      converted[key] = value
    }
  }
  return converted
}
