const cds = require("@sap/cds")

// Enable doc comments in CSN for agent card generation
cds.env.cdsc = { ...cds.env.cdsc, docComment: true }

// Register A2A as a CDS protocol adapter
const protocols = (cds.env.protocols ??= {})
if (!protocols.a2a) {
  protocols.a2a = {
    path: "/a2a",
    impl: require.resolve("./lib"),
  }
}
