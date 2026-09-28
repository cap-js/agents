using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Browse and order books
 */
@agent  @odata
@Core.SchemaVersion: '0'
@description: 'Browse and order books from the catalog'
service CatalogService {

  // Named complex type used as an action return type (with nested + arrayed PII).
  type AuthorDossier {
    @PersonalData.IsPotentiallyPersonal
    name       : String;
    biography  : String;
    contact    : {
      @PersonalData.IsPotentiallyPersonal
      email : String;
      phone : String;
    };
    aliases    : array of {
      @PersonalData.IsPotentiallyPersonal
      alias : String;
    };
  }

  /**
   * Book details with author information
   */
  @readonly
  entity Books       as
    projection on my.Books {
      *,
      author.name as authorName
    }
    excluding {
      author,
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
   * Pseudonymized authors of the books on offer
   */
  @readonly
  entity Authors     as
    projection on my.Authors
    excluding {
      books
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

  // used for pseudonymization tests
  @description: 'Look up author contact details'
  function findAuthor(searchTerm : String) returns {
    ID: String;
    @PersonalData.IsPotentiallyPersonal
    name  : String;
    dateOfBirth : Date;
  };

  // ── complex action return types for pseudonymization tests ──────────────
  // top-level scalar PII return (returns String @PersonalData)
  @description: 'Get an author name as a scalar'
  function authorName(id : Integer) returns String @PersonalData.IsPotentiallyPersonal;

  // top-level scalar PII return that is UI-masked (@Common.Masked)
  @description: 'Get a masked author secret as a scalar'
  function authorSecret(id : Integer) returns String @PersonalData.IsPotentiallyPersonal @Common.Masked;

  // top-level arrayed scalar of PII (returns array of String)
  @description: 'Get all names of an author as a scalar array'
  function authorAllNames(id : Integer) returns array of String @PersonalData.IsPotentiallyPersonal;

  // arrayed scalar of PII nested in a struct (nicknames : many String)
  @description: 'Get author with a list of nicknames'
  function authorWithNicknames(id : Integer) returns {
    @PersonalData.IsPotentiallyPersonal
    name      : String;
    @PersonalData.IsPotentiallyPersonal
    nicknames : many String;
  };

  // arrayed scalar of PII (many String)
  @description: 'List author names'
  function listAuthorNames(searchTerm : String) returns array of {
    @PersonalData.IsPotentiallyPersonal
    name : String;
  };

  // arrayed struct (many { name: String, city: String })
  @description: 'List author contacts'
  function listAuthorContacts() returns array of {
    @PersonalData.IsPotentiallyPersonal
    name : String;
    @PersonalData.IsPotentiallyPersonal
    city : String;
    country : String;
  };

  // nested struct (abc: { def: String })
  @description: 'Author profile with nested address'
  function authorProfile(id : Integer) returns {
    @PersonalData.IsPotentiallyPersonal
    name    : String;
    address : {
      @PersonalData.IsPotentiallyPersonal
      street : String;
      city   : String;
    };
  };

  // named complex type referenced from the return
  @description: 'Author dossier using a named type'
  function authorDossier(id : Integer) returns AuthorDossier;

  // deeply nested + arrayed combination
  @description: 'Author with many past addresses'
  function authorWithHistory(id : Integer) returns {
    @PersonalData.IsPotentiallyPersonal
    name      : String;
    addresses : array of {
      @PersonalData.IsPotentiallyPersonal
      street : String;
      city   : String;
    };
  };
  /**
   * Validate an order — always rejects with two field-level errors.
   * Used to test that err.details from multi-error CAP responses are
   * forwarded to the LLM via toolWrapMiddleware.
   */
  @description: 'Validate an order (always fails with two errors for testing)'
  action validateOrder(book: Books:ID, quantity: Integer) returns {};
}
