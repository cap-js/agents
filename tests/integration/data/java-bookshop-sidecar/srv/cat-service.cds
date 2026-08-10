@agent
@description: 'AI-powered bookshop catalog assistant'
service CatalogService {
  @readonly entity Books { key ID: Integer; title: String; stock: Integer; };
  /** Submit an order for a book */
  action submitOrder(book: Integer, quantity: Integer) returns String;
  /** Get current stock level for a book */
  function getStock(book: Integer) returns Integer;
}
