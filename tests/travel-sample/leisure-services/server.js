import cds from "@sap/cds"

cds.on("bootstrap", (app) => {
  app.use((req, res, next) => {
    res.set("access-control-allow-origin", req.headers.origin || "*")
    res.set("access-control-allow-headers", "content-type, authorization, accept")
    res.set("access-control-allow-methods", "GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS")
    res.set("access-control-allow-credentials", "true")
    if (req.method === "OPTIONS") return res.status(204).end()
    next()
  })
})

export default cds.server
