using { sample.products } from '../db/schema';

/**
 * Product catalog agent for searching products and managing orders.
 */
@a2a
service ProductAgentService {
  @readonly entity Products as projection on products.Products;

  /**
   * Place an order for a product. Looks up the product by name, validates stock, and decrements inventory.
   *
   * Example: Order 5 Widget Pro
   */
  action orderProduct(productName: String, quantity: Integer) returns String;
}
