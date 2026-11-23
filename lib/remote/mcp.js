import cds from "@sap/cds"
import { TextDecoderStream } from "node:stream/web"

const LOG = cds.log("agents:mcp")
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"]

/** Discovery and invocations resolve credentials independently and never share sessions. */
export function mcpClient(connection) {
  return {
    listTools: (signal) =>
      withSession(connection, signal, async (session) => {
        const tools = []
        const cursors = new Set()
        let cursor
        do {
          // Pagination depends on the preceding response.
          // eslint-disable-next-line no-await-in-loop
          const page = await session.request("tools/list", cursor ? { cursor } : {})
          if (!Array.isArray(page?.tools)) throw new Error("Invalid MCP tools/list response.")
          tools.push(...page.tools)
          cursor = page.nextCursor
          if (cursor && (typeof cursor !== "string" || cursors.has(cursor))) {
            throw new Error("Invalid MCP tools/list pagination cursor.")
          }
          cursors.add(cursor)
        } while (cursor)
        return tools
      }),
    callTool: (name, args, signal) =>
      withSession(connection, signal, async (session) => {
        const response = await session.request("tools/call", { name, arguments: args })
        if (!Array.isArray(response?.content)) throw new Error("Invalid MCP tools/call response.")
        return response
      }),
  }
}

async function withSession(connection, signal, run) {
  signal?.throwIfAborted()
  const session = new McpSession(await connection.resolve(), signal)
  try {
    await session.initialize()
    return await run(session)
  } finally {
    await session.close()
  }
}

/** A short-lived Streamable HTTP session. No server-initiated capabilities are advertised. */
class McpSession {
  constructor(connection, signal) {
    this.connection = connection
    this.signal = signal
    this.nextId = 0
  }

  async initialize() {
    const initialized = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSIONS[0],
      capabilities: {},
      clientInfo: { name: "cap-js-agents", version: "1.0.0" },
    })
    if (!PROTOCOL_VERSIONS.includes(initialized?.protocolVersion)) {
      throw new Error("Unsupported MCP protocol version: " + initialized?.protocolVersion)
    }
    this.version = initialized.protocolVersion
    await this.send({ method: "notifications/initialized" })
  }

  request(method, params) {
    return this.send({ id: ++this.nextId, method, ...(params && { params }) })
  }

  async close() {
    if (!this.sessionId) return
    try {
      const response = await this.connection.fetch(this.connection.url, {
        method: "DELETE",
        headers: this.headers(),
        // Cleanup must also run after cancellation, but must not hold up the caller.
        signal: AbortSignal.timeout(5000),
      })
      await response.body?.cancel()
      if (!response.ok && response.status !== 404 && response.status !== 405) {
        LOG.debug("MCP session cleanup returned HTTP " + response.status)
      }
    } catch (error) {
      LOG.debug("MCP session cleanup failed: " + error.message)
    }
  }

  headers() {
    return {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(this.sessionId && { "mcp-session-id": this.sessionId }),
      ...(this.version && { "mcp-protocol-version": this.version }),
    }
  }

  async send(message) {
    const response = await this.connection.fetch(this.connection.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
      signal: this.signal,
    })
    if (message.method === "initialize") this.sessionId = response.headers.get("mcp-session-id")
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error("MCP " + (message.method || "response") + " failed: HTTP " + response.status)
    }
    // Notifications and responses to server requests have no JSON-RPC response.
    if (!Object.hasOwn(message, "id") || !message.method) {
      await response.body?.cancel()
      return
    }
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
    if (type === "application/json") return result(await response.json(), message.id)
    if (type !== "text/event-stream" || !response.body) {
      await response.body?.cancel()
      throw new Error("Expected an MCP JSON or SSE response for " + message.method + ".")
    }
    for await (const incoming of messages(response.body)) {
      if (incoming.jsonrpc !== "2.0") throw new Error("Invalid MCP JSON-RPC message.")
      if (incoming.method && Object.hasOwn(incoming, "id")) {
        // Ping is always available; sampling, roots and elicitation were not advertised.
        // eslint-disable-next-line no-await-in-loop
        await this.send({
          id: incoming.id,
          ...(incoming.method === "ping"
            ? { result: {} }
            : { error: { code: -32601, message: "Method not supported" } }),
        })
      } else if (!incoming.method && incoming.id === message.id) {
        return result(incoming, message.id)
      }
    }
    throw new Error("MCP stream ended without a response for " + message.method + ".")
  }
}

// SSE data can span lines, chunks and UTF-8 code points. Returning from the consumer
// cancels the stream, including servers that leave it open after the RPC response.
async function* messages(body) {
  let buffer = ""
  let data = []
  let skipLF = false
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    if (!chunk) continue
    buffer += skipLF ? chunk.replace(/^\n/, "") : chunk
    skipLF = false
    let end
    while ((end = buffer.search(/[\r\n]/)) !== -1) {
      const line = buffer.slice(0, end)
      const width = buffer.slice(end, end + 2) === "\r\n" ? 2 : 1
      skipLF = buffer[end] === "\r" && end === buffer.length - 1
      buffer = buffer.slice(end + width)
      if (!line) {
        if (data.length) yield JSON.parse(data.join("\n"))
        data = []
      } else if (line === "data" || line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""))
      }
    }
  }
}

function result(message, id) {
  if (
    message?.jsonrpc !== "2.0" ||
    message.id !== id ||
    Object.hasOwn(message, "result") === Object.hasOwn(message, "error")
  ) {
    throw new Error("Invalid MCP JSON-RPC response.")
  }
  if (message.error) {
    throw Object.assign(new Error(message.error.message || "MCP request failed."), {
      code: message.error.code,
    })
  }
  return message.result
}
