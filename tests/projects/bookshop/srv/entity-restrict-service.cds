using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Service with no @requires (accessible to all authenticated users),
 * but contains one entity restricted via @restrict to admin role only.
 * Used to test entity-level @restrict enforcement through tool calls.
 */
@agent
service EntityRestrictService {
  @restrict: [{ grant: 'READ', to: 'admin' }]
  @readonly
  entity SecretBooks as projection on my.Books { ID, title, 'ADMIN_ONLY_SENTINEL' as secret : String };
}
