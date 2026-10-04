import cds from "@sap/cds"

cds.on("bootstrap", (app) => {
  app.get("/test/crash", (_req, res) => {
    res.status(204).end()
    setImmediate(() => {
      throw new Error("intentional crash for task recovery test")
    })
  })
})
