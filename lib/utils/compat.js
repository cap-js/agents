import cds from "@sap/cds"

const cache = new Map()

export async function token(credentials, options = {}) {
  if (cds.utils.token) return cds.utils.token(credentials, options)

  const configured =
    options.endpoint ??
    options.token_endpoint ??
    credentials.token_endpoint ??
    credentials.token_url ??
    credentials.tokenurl
  const endpoint = new URL(configured ?? credentials.url)
  if (options.subdomain) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(options.subdomain))
      throw new Error("invalid subdomain")
    const dot = endpoint.hostname.indexOf(".")
    endpoint.hostname = options.subdomain + (dot >= 0 ? endpoint.hostname.slice(dot) : "")
  }
  if (!configured || options.path) endpoint.pathname = options.path ?? "/oauth/token"
  for (const [name, value] of Object.entries(options.query ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  ))
    endpoint.searchParams.append(name, value)
  const form = { grant_type: "client_credentials", ...options.form }
  const stableForm = Object.entries(form).sort(([a], [b]) => a.localeCompare(b))
  const key = JSON.stringify([
    endpoint.toString(),
    credentials.clientid,
    options.tenant,
    stableForm,
  ])
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.token

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    ...(options.tenant && { "x-zid": options.tenant }),
  }
  if (credentials.clientsecret) {
    headers.Authorization =
      "Basic " +
      Buffer.from(`${credentials.clientid}:${credentials.clientsecret}`).toString("base64")
  }
  const timeoutSignal = options.timeout ? AbortSignal.timeout(options.timeout) : undefined
  const signal =
    options.signal && timeoutSignal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : (options.signal ?? timeoutSignal)
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: new URLSearchParams({ client_id: credentials.clientid, ...form }),
    signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    let data
    try {
      data = JSON.parse(body)
    } catch {
      data = body
    }
    throw Object.assign(
      new Error(
        `OAuth token request failed with status ${response.status}: ${data?.error_description ?? data?.error ?? body.slice(0, 200)}`,
      ),
      { status: response.status, data, headers: Object.fromEntries(response.headers.entries()) },
    )
  }
  const result = await response.json()
  if (!result.access_token) throw new Error("OAuth token response is missing access_token")
  cache.set(key, {
    token: result.access_token,
    expires: Date.now() + Math.max(0, (result.expires_in ?? 3600) * 1000 - 60_000),
  })
  return result.access_token
}
