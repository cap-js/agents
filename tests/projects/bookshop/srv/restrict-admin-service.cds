using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Service using `@restrict` with an explicit `to: 'admin'` role. Verifies
 * parity between `@restrict` (with `to`) and `@requires` — only admins allowed.
 */
@agent
@(restrict: [{ grant: '*', to: 'admin' }])
@description: 'Admin-only agent via `@restrict` with `to: admin`'
service RestrictAdminService {
  @readonly entity Books as projection on my.Books { ID, title, createdBy };
}
