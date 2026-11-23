import cds from "@sap/cds"
import { Readable } from "node:stream"
import { getTracer } from "../telemetry/metrics.js"

const LOG = cds.log("agents:remote")

/**
 * Fetch transport for MCP and A2A, with CAP remote-service credentials and Cloud SDK
 * connectivity (including destinations, OAuth, proxies and client certificates).
 * Only configuration is shared; destination resolution uses the current CDS context.
 */
export function outboundConnection(serviceName, protocol) {
  const options = cds.requires[serviceName]
  if (!options?.credentials) throw new Error('No credentials configured for "' + serviceName + '".')

  return {
    async resolve() {
      const initial = await resolveDestination(serviceName, options)
      const base = endpointUrl(initial.url, serviceName, options, protocol)
      return {
        url: base.href.replace(/\/$/, ""),
        fetch: (input, init) =>
          fetchOutbound(input, init, { serviceName, options, protocol, base }),
      }
    },
  }
}

async function fetchOutbound(input, init = {}, { serviceName, options, protocol, base }) {
  const request = new Request(input, init)
  request.signal.throwIfAborted()
  const target = new URL(request.url)
  if (target.origin !== base.origin || target.username || target.password) {
    throw new Error('Outbound URL for "' + serviceName + '" must use origin ' + base.origin + ".")
  }
  const current = await resolveDestination(serviceName, options)
  const endpoint = endpointUrl(current.url, serviceName, options, protocol)
  // Agent cards may advertise other paths on the same host. Rebase paths under
  // the service endpoint as well as the host when a destination changes.
  const basePath = base.pathname.replace(/\/$/, "")
  if (target.pathname === basePath || target.pathname.startsWith(basePath + "/")) {
    target.pathname = endpoint.pathname.replace(/\/$/, "") + target.pathname.slice(basePath.length)
  }
  const headers = Object.fromEntries(request.headers)
  const correlationId = headers["x-correlation-id"] ?? cds.context?.id
  if (correlationId) {
    headers["x-correlation-id"] = correlationId
    headers["x-correlationid"] ??= correlationId
  }
  if (getTracer()) {
    const { context, propagation } = await import("@opentelemetry/api")
    propagation.inject(context.active(), headers)
  }
  const timeout = cds.utils.ms4(
    options.credentials?.requestTimeout ?? cds.env.remote?.timeout ?? 60000,
  )
  const signal =
    timeout > 0 ? AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]) : request.signal
  const { executeHttpRequestWithOrigin } = await import("@sap-cloud-sdk/http-client")
  const response = await executeHttpRequestWithOrigin(
    { ...current, url: endpoint.origin },
    {
      url: target.pathname + target.search,
      method: request.method,
      // Cloud SDK v4: custom headers have the same precedence as CAP req.headers.
      headers: { custom: headers },
      data: request.body ? Readable.fromWeb(request.body) : undefined,
      signal,
      timeout,
      maxBodyLength: cds.env.remote?.max_body_length,
      responseType: "stream",
      validateStatus: () => true,
      maxRedirects: 0,
    },
    { fetchCsrfToken: false },
  )
  const responseHeaders = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (value != null) {
      for (const item of Array.isArray(value) ? value : [value]) {
        responseHeaders.append(name, String(item))
      }
    }
  }
  const noBody = request.method === "HEAD" || [204, 205, 304].includes(response.status)
  if (noBody) response.data.destroy()
  return new Response(noBody ? null : Readable.toWeb(response.data), {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  })
}

async function resolveDestination(serviceName, options) {
  const credentials = options.credentials
  const config = typeof credentials === "object" ? credentials : {}
  const destinationName =
    typeof credentials === "string"
      ? credentials
      : (config.destination ?? (!config.url && config.name))
  let jwt = userJwt()
  let resolved
  if (destinationName) {
    const { getDestination, DestinationSelectionStrategies } =
      await import("@sap-cloud-sdk/connectivity")
    const destinationOptions = { ...options.destinationOptions }
    if (typeof destinationOptions.selectionStrategy === "string") {
      const name = destinationOptions.selectionStrategy
      const strategy = DestinationSelectionStrategies[name]
      if (typeof strategy !== "function") {
        throw new Error('Unsupported destination selection strategy "' + name + '".')
      }
      destinationOptions.selectionStrategy = strategy
    }
    if (destinationOptions.jwt === undefined) destinationOptions.jwt = jwt
    jwt = destinationOptions.jwt
    if (!destinationOptions.jwt) delete destinationOptions.jwt
    resolved = await getDestination({ ...destinationOptions, destinationName })
    if (!resolved?.url) throw new Error('Cannot resolve destination "' + destinationName + '".')
  } else {
    if (!config.url) throw new Error('No URL configured for "' + serviceName + '".')
    resolved = {
      ...config,
      queryParameters: config.queryParameters ?? config.queries,
      authentication:
        config.authentication ||
        (config.username != null || config.password != null
          ? "BasicAuthentication"
          : "NoAuthentication"),
    }
  }
  const headers = new Headers(resolved.headers)
  if (resolved.forwardAuthToken) {
    if (jwt) headers.set("authorization", "Bearer " + jwt)
    else LOG.warn('Missing JWT token for forwardAuthToken on "' + serviceName + '".')
    resolved = { ...resolved, forwardAuthToken: false, authentication: "NoAuthentication" }
  } else if (resolved.authentication === "NoAuthentication") {
    const token = resolved.authTokens?.find((t) => !t.error && t.value)
    if (token) headers.set("authorization", (token.type || "Bearer") + " " + token.value)
  }
  return { ...resolved, headers: Object.fromEntries(headers) }
}

function userJwt() {
  const ctx = cds.context
  return (
    ctx?.user?.authInfo?.token?.jwt ||
    ctx?.headers?.authorization?.match(/^Bearer (.+)$/i)?.[1] ||
    ctx?.http?.req?.headers?.authorization?.match(/^Bearer (.+)$/i)?.[1]
  )
}

function endpointUrl(url, serviceName, options, protocol) {
  const target = new URL(url)
  target.pathname = target.pathname.replace(/\/$/, "") || "/"
  const definition = cds.model?.definitions?.[serviceName]
  if (definition && options.kind !== protocol) {
    const endpoints = Object.fromEntries(
      cds.service.endpoints4({ name: serviceName, definition }).map((e) => [e.kind, e.path]),
    )
    // cds connect --to may supply an /undefined endpoint for a protocol-only service.
    const from = options.kind === undefined ? "/undefined" : endpoints[options.kind]
    if (from && endpoints[protocol] && target.pathname.endsWith(from)) {
      target.pathname = target.pathname.slice(0, -from.length) + endpoints[protocol]
    }
  }
  const path = options.credentials?.path
  if (path) target.pathname = target.pathname.replace(/\/$/, "") + "/" + path.replace(/^\//, "")
  target.pathname = target.pathname.replace(/\/$/, "") || "/"
  return target
}
