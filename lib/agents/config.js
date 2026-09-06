import cds from "@sap/cds"

export const AGENT_DEFAULTS = {
  quota: {
    maxConcurrentTasks: 10,
    maxConcurrentTasksPerUser: 4,
    maxTasksPerHour: 100,
    maxTasksPerHourPerUser: 20,
    maxLLMTokensPerDay: 5000000,
    maxToolCallsPerHour: 1000,
    maxToolCallsPerTask: 50,
    maxLLMInvocationsPerTask: 50,
    maxLLMTokensPerTask: 200000,
    maxExecutionTimePerTask: "5min",
    timeoutGrace: "15s",
    maxIncomingMessageLength: 5000,
  },
  fileIO: {
    enabled: false,
    maxInputFileSizeBytes: 2097152,
    maxOutputFileSizeBytes: 10485760,
    defaultInputModes: [
      "text/csv",
      "application/json",
      "text/plain",
      "application/pdf",
      "image/png",
      "image/jpeg",
    ],
    defaultOutputModes: [
      "text/csv",
      "application/json",
      "text/plain",
      "application/pdf",
      "image/png",
      "image/jpeg",
    ],
  },
  dataRetention: "30d",
  persistAllCheckpointWrites: false,
}

/** Resolve an @agent.<key> annotation for a service, with built-in defaults. */
export function agentConfig(service, key) {
  const srv = typeof service === "string" ? cds.services[service] : service
  const annotation = srv?.definition?.[`@agent.${key}`]
  const fallback = AGENT_DEFAULTS[key]
  if (annotation === false) return false
  if (key === "fileIO" && annotation != null) {
    return { ...fallback, ...(typeof annotation === "object" ? annotation : {}), enabled: true }
  }
  if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) {
    return { ...fallback, ...(annotation || {}) }
  }
  return annotation ?? fallback
}

/** Resolve configuration for current request's agent service. */
export function activeAgentConfig(key) {
  return agentConfig(cds.context?.["agent.service"], key)
}
