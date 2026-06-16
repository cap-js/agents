using {sample.products} from '../db/schema';

/**
 * Demonstrates explicit overrides of the convention:
 *   - `@a2a.directory` points to an agent dir whose name does NOT match the
 *     slugified service name.
 *   - `@a2a.card` points to a markdown agent-card OUTSIDE the agent dir.
 *
 * Both paths are resolved relative to this `.cds` file's directory.
 */
@a2a
@a2a.directory: 'card-override-agent'
@a2a.card     : 'card-override-agent/cards/card-override.md'
service OverrideCardService {
  @readonly
  entity Products as projection on products.Products;
}
