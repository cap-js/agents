using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Service with no service-level @requires but ONE action that is @requires-gated.
 * Mirrors the real upstream `capire/bookshop` shape (open service + gated action)
 * and drives the preview auth-challenge test for the action-level branch.
 */
@agent
service ActionRequiresService {
  @readonly entity Books as projection on my.Books { ID, title };

  @requires: 'authenticated-user'
  action    submitOrder(book: Books:ID, quantity: Integer) returns { stock: Integer };
}
