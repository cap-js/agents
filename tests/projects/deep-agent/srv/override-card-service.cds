using {sample.products} from '../db/schema';

@agent
@agent.directory: 'card-override-agent'
service OverrideCardService {
  @readonly
  entity Products as projection on products.Products;
}
