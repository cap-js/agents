import cds from "@sap/cds"
import { AsyncLocalStorage } from "node:async_hooks"

// Polyfill cds._with for CDS 8 compatibility.
// CDS 10+ exposes cds._with(ctx, fn) for running code within a context.
// CDS 8 lacks _with — we add it using CDS's own context mechanism.
if (typeof cds._with !== "function") {
  cds._with = function (ctx, fn, ...args) {
    const resolved = typeof ctx !== "object" ? ctx : ctx.context || ctx
    if (!fn) {
      cds.context = resolved
      return
    }
    const prev = cds.context
    cds.context = resolved
    try {
      const result = fn(...args)
      if (result?.then)
        return result.finally(() => {
          cds.context = prev
        })
      cds.context = prev
      return result
    } catch (e) {
      cds.context = prev
      throw e
    }
  }
}
