import cds from "@sap/cds"

export class CatalogService extends cds.ApplicationService {
  async init() {
    this.on("submitOrder", async ({ data: { book, quantity } }) => {
      const { Books } = this.entities
      const [{ stock }] = await SELECT.from(Books).where({ ID: book }).columns("stock")

      if (stock < quantity) {
        return this.error(409, `Insufficient stock for book ${book}: only ${stock} left`)
      }

      await UPDATE(Books)
        .where({ ID: book })
        .with({ stock: stock - quantity })
      return { stock: stock - quantity }
    })

    this.on("getStock", async ({ data: { book } }) => {
      const { Books } = this.entities
      const [row] = await SELECT.from(Books).where({ ID: book }).columns("stock")
      return row?.stock ?? 0
    })

    return super.init()
  }
}
