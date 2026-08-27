using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Test-only agent whose graph awaits the AbortSignal from config.signal.
 * Used by client-disconnect.test.js to force a deterministic long-running
 * task so the disconnect abort path can be observed reliably.
 */
@agent
service SlowAgentService {
  @readonly entity Books as projection on my.Books;
}
