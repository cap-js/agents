import cds from "@sap/cds"

const LOG = cds.log("agents")

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_RETRIES = 3
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 32_000

/**
 * Resilience middleware for the SAP AI SDK HTTP layer.
 * Contract: (options: { fn, context: { uri, tenantId } }) => (arg) => Promise
 * Compose right-to-left: [timeout(t), circuitBreaker()] wraps timeout around
 * circuit breaker around the request.
 */

export function timeout(ms = DEFAULT_TIMEOUT_MS) {
  if (ms <= 0) throw new Error("Timeout must be greater than 0.")
  if (ms < 10) LOG.warn(`The timeout of ${ms} ms is too low. Make sure this is not intentional.`)

  return ({ fn, context }) =>
    (arg) => {
      const controller = new AbortController()
      const signal = arg?.signal
        ? AbortSignal.any([arg.signal, controller.signal])
        : controller.signal
      const request = arg && typeof arg === "object" ? { ...arg, signal } : arg
      let timer
      const call = fn(request).finally(() => clearTimeout(timer))
      const race = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`Request to URL: ${context?.uri} ran into a timeout after ${ms}ms.`))
        }, ms)
      })
      return Promise.race([call, race])
    }
}

// Retries on 5xx / network errors; bails immediately on 4xx.
export function retry(retries = DEFAULT_RETRIES) {
  if (retries < 0) throw new Error("Number of retries must be greater or equal to 0.")

  return ({ fn }) =>
    async (arg) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn(arg) // eslint-disable-line no-await-in-loop
        } catch (error) {
          const status = error?.response?.status
          if (status == null)
            LOG.debug("HTTP request failed without a response status. Rethrowing.")
          else if (`${status}`.startsWith("4"))
            throw Object.assign(new Error(`Request failed with status code ${status}`), {
              cause: error,
            })
          if (attempt >= retries) throw error
          const delay =
            Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt) * (1 + Math.random())
          await new Promise((r) => setTimeout(r, delay)) // eslint-disable-line no-await-in-loop
        }
      }
    }
}

// One breaker per uri. Opens after volumeThreshold calls exceed the
// error rate; fails fast with EOPENBREAKER while open. 4xx never trips it.
export const circuitBreakers = {}

export function circuitBreaker() {
  return ({ fn, context }) =>
    (arg) => {
      const key = context?.uri ?? "default"
      circuitBreakers[key] ??= new CircuitBreaker()
      return circuitBreakers[key].fire(fn, arg)
    }
}

class CircuitBreaker {
  #state = "closed"
  #openedAt = 0
  #window = []

  async fire(fn, arg) {
    const now = Date.now()
    const opts = cds.env.agents.circuitBreaker
    if (this.#state === "open") {
      if (now - this.#openedAt < opts.resetTimeout)
        throw Object.assign(new Error("Breaker is open"), { code: "EOPENBREAKER" })
      this.#state = "half-open"
    }
    try {
      const result = await fn(arg)
      if (this.#state === "half-open") this.#reset("closed")
      else this.#record(true, now)
      return result
    } catch (error) {
      if (!`${error?.response?.status}`.startsWith("4")) this.#onError(now)
      throw error
    }
  }

  #onError(now) {
    if (this.#state === "half-open") {
      this.#reset("open", now)
      return
    }
    this.#record(false, now)
    if (this.#shouldOpen()) this.#reset("open", now)
  }

  #record(success, now) {
    const { rollingCountTimeout } = cds.env.agents.circuitBreaker
    const cutoff = now - rollingCountTimeout
    while (this.#window.length && this.#window[0].t < cutoff) this.#window.shift()
    this.#window.push({ success, t: now })
  }

  #shouldOpen() {
    const { volumeThreshold, errorThresholdPercentage } = cds.env.agents.circuitBreaker
    if (this.#window.length < volumeThreshold) return false
    const failures = this.#window.filter((o) => !o.success).length
    return (failures / this.#window.length) * 100 >= errorThresholdPercentage
  }

  #reset(state, openedAt = 0) {
    this.#state = state
    this.#openedAt = openedAt
    this.#window = []
  }
}

