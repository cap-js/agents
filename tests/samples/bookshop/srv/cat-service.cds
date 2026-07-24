using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Browse and order books
 */
@agent  @odata
@Core.SchemaVersion: '0'
@description: 'Browse and order books from the catalog'
service CatalogService {

  /**
   * Book details with author information
   */
  @readonly
  entity Books       as
    projection on my.Books {
      *,
      author.name as author
    }
    excluding {
      createdBy,
      modifiedBy
    };

  /**
   * Browse available books
   */
  @description: 'Browse available books'
  @readonly
  entity ListOfBooks as
    projection on Books
    excluding {
      descr
    };

  /**
   * Submit an order for a book
   * Example: Order 2 copies of Wuthering Heights
   */
  @description: 'Submit an order for a book'
  @agent.hitl
  action   submitOrder(book: Books:ID @mandatory,
                       quantity: Integer @mandatory
  )                                                                              returns {
    stock : Integer
  };

  /**
   * Get current stock level for a book
   * Example: Get stock level for Wuthering Heights
   */
  @description: 'Get stock level for a specific book'
  function getStock(  @description: 'The book ID'  book: Books:ID  @mandatory  ) returns Integer;
}
