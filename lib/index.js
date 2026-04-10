const cds = require("@sap/cds")
const express = require("express")

module.exports = function A2AProtocolAdapter(srv) {
  if (!(srv instanceof cds.ApplicationService)) return null

  const router = express.Router()

  // TODO:  agent card endpoint
  // GET /.well-known/agent-card.json

  // TODO: JSON-RPC endpoint
  // POST /

  return router
}
