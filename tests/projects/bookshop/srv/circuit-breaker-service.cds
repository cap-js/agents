using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Circuit breaker integration test service.
 * Uses real OrchestrationClient with circuitBreaker() + timeout() middleware
 * pointed at a mock AI Core server.
 */
@agent
@odata
@Core.Links : [
  {
      rel : 'via',
      href : 'https://example.com/agent/circuit-breaker',
  },
]
@description: 'Circuit breaker test agent'
service CircuitBreakerService {
  @readonly
  entity Books as projection on my.Books { ID, title, stock };

  // Test-only: reset all circuit breaker state so tests don't wait out resetTimeout.
  action resetBreakers();
}
