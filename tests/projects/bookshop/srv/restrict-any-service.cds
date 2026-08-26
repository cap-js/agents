using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Service using `@restrict` with `to: 'any'` — the explicit public pseudo-role.
 * Anonymous callers must be allowed through per CAP semantics.
 */
@agent
@(restrict: [{ grant: '*', to: 'any' }])
@description: 'Public agent via `@restrict` with `to: any`'
service RestrictAnyService {
  @readonly entity Books as projection on my.Books { ID, title, createdBy };
}
