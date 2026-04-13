const cds = require("@sap/cds")

module.exports = ({ POST, axios }) => {
  axios.defaults.validateStatus = () => true

  function jsonrpc(service, method, params = {}) {
    return POST(`/a2a/${service}/`, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    })
  }

  function sendMessage(service, text, contextId) {
    return jsonrpc(service, "message/send", {
      message: {
        kind: "message",
        messageId: cds.utils.uuid(),
        role: "user",
        ...(contextId && { contextId }),
        parts: [{ kind: "text", text }],
      },
    })
  }

  return { jsonrpc, sendMessage }
}
