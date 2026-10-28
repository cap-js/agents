using {sap.capire.bookshop as my} from '../db/schema';

@agent
@agent.llm: 'aicoreLlamaGuard'
@description: 'AI Core Llama Guard content filter test agent'
service AICoreLlamaGuardService {
  @readonly
  entity Books as projection on my.Books { ID, title, stock };
}
