using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Circuit breaker integration test service.
 * Uses real OrchestrationClient with circuitBreaker() + timeout() middleware
 * pointed at a mock AI Core server.
 */
@a2a
@description: 'Circuit breaker test agent'
service CircuitBreakerService {
  @readonly
  entity Books as projection on my.Books { ID, title, stock };
}
