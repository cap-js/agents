using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Browse and order books
 */
@agent
@description: 'AI-powered bookshop catalog assistant'
service CatalogService {

  /** Browse available books */
  @readonly entity Books as projection on my.Books;

  /** Submit an order for a book */
  @description: 'Submit an order for a book'
  action submitOrder(
    @description: 'The book ID' book : Integer,
    @description: 'Number of copies' quantity : Integer
  ) returns { stock : Integer };

  /** Get current stock level for a book */
  @description: 'Get stock level for a specific book'
  function getStock(
    @description: 'The book ID' book : Integer
  ) returns Integer;
}
