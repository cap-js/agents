using {sap.capire.bookshop as my} from '../db/schema';

@agent @hcql
@odata
@description: 'AI-powered bookshop catalog assistant'
service CatalogService {

  @description: 'Browse available books'
  @readonly entity Books as projection on my.Books;

  @description: 'Browse book authors'
  @readonly entity Authors as projection on my.Authors;

  /** Submit an order for a book by its ID and quantity */
  @description: 'Submit an order for a book'
  action submitOrder(
    @description: 'The book ID to order' book : Integer,
    @description: 'Number of copies' quantity : Integer
  ) returns String;

  /** Get current stock level for a book */
  @description: 'Get stock level for a specific book'
  function getStock(
    @description: 'The book ID' book : Integer
  ) returns Integer;
}
