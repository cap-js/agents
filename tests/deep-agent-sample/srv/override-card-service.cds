using {sample.products} from '../db/schema';

/**
 * Demonstrates explicit overrides of the convention:
 *   - `@agent.directory` points to an agent dir whose name does NOT match the
 *     slugified service name.
 *   - `@agent.card` points to a markdown agent-card OUTSIDE the agent dir.
 *
 * Both paths are resolved relative to this `.cds` file's directory.
 */
@agent
@agent.directory: 'card-override-agent'
@agent.card     : 'card-override-agent/cards/card-override.md'
service OverrideCardService {
  @readonly
  entity Products as projection on products.Products;
}
