const _sessions = new Map()
let _registered = false
let _sessionCounter = 0

const _processor = {
  onStart() {},
  onEnd(span) {
    if (_sessions.size === 0) return
    for (const session of _sessions.values()) {
      session.spans.push(span)
    }
  },
  async forceFlush() {},
  async shutdown() {},
}

async function _ensureRegistered() {
  if (_registered) return
  _registered = true
  try {
    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.constructor?.name === "NoopTracerProvider") return
    if (typeof delegate.addSpanProcessor === "function") {
      delegate.addSpanProcessor(_processor)
    } else if (Array.isArray(delegate._activeSpanProcessor?._spanProcessors)) {
      delegate._activeSpanProcessor._spanProcessors.push(_processor)
    }
  } catch {
    /* OTel not present */
  }
}

function _openSession() {
  const id = ++_sessionCounter
  const session = { spans: [] }
  _sessions.set(id, session)
  return {
    collect() {
      _sessions.delete(id)
      return session.spans
    },
  }
}

export async function startCollection() {
  await _ensureRegistered()
  return _openSession()
}
