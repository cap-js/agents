using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Service with `@restrict` privilege but no `to` role list. The adapter must
 * fail closed — normalize to `authenticated-user`, NOT anonymous.
 */
@agent
@(restrict: [{ grant: '*' }])
@description: 'Restricted agent — @restrict without `to`'
service RestrictNoToService {
  @readonly entity Books as projection on my.Books { ID, title, createdBy };
}
