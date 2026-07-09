import cds from "@sap/cds"
import { ChatAnthropic } from "@langchain/anthropic"

export default class CatalogService extends cds.ApplicationService {
  init() {
    const { Books, ListOfBooks } = this.entities

    // Add some discount for overstocked books
    this.after("each", ListOfBooks, (book) => {
      if (book.stock > 111) book.title += ` -- 11% discount!`
    })

    // Reduce stock of ordered books if available stock suffices
    this.on("submitOrder", async (req) => {
      let { book: id, quantity } = req.data
      let book = await SELECT.one.from(Books, id, (b) => b.stock)

      // Validate input data
      if (!book) return req.error(404, `Book #${id} doesn't exist`)
      if (quantity < 1) return req.error(400, `quantity has to be 1 or more`)
      if (!book.stock || quantity > book.stock)
        return req.error(409, `${quantity} exceeds stock for book #${id}`)

      // Reduce stock in database and return updated stock value
      await UPDATE(Books, id).with({ stock: (book.stock -= quantity) })
      return book
    })

    // Get current stock level for a book
    this.on("getStock", async (req) => {
      const { book: id } = req.data
      const book = await SELECT.one.from(Books, id, (b) => b.stock)
      if (!book) return req.error(404, `Book #${id} doesn't exist`)
      return book.stock
    })

    // Use the Hyperspace AI Proxy
    // this.agent = {
    //   model: new ChatAnthropic({
    //     model: "claude-sonnet-4-5",
    //     anthropicApiKey: "<api-key>",
    //     anthropicApiUrl: "http://localhost:6655/anthropic",
    //   }),
    // }

    return super.init()
  }
}
