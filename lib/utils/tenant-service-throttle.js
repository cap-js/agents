/**
 * Throttle work independently for each tenant and service.
 */
export function createTenantServiceThrottle(windowMs) {
  const triggered = new Map()

  function serviceMap(tenant) {
    if (!triggered.has(tenant)) triggered.set(tenant, new Map())
    return triggered.get(tenant)
  }

  return {
    shouldTrigger(tenant, serviceName) {
      const lastTriggered = serviceMap(tenant).get(serviceName)
      return !lastTriggered || lastTriggered <= Date.now() - windowMs
    },
    markTriggered(tenant, serviceName) {
      serviceMap(tenant).set(serviceName, Date.now())
    },
    reset() {
      triggered.clear()
    },
  }
}
