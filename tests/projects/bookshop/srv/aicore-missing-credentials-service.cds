using {sap.capire.bookshop as my} from '../db/schema';

@agent
@agent.llm: 'aicoreMissingCredentialsFilterOn'
@description: 'AI Core missing credentials test agent with content filter'
service AICoreMissingCredentialsFilterOnService {
  @readonly
  entity Books as projection on my.Books { ID, title, stock };
}

@agent
@agent.llm: 'aicoreMissingCredentialsFilterOff'
@description: 'AI Core missing credentials test agent without content filter'
service AICoreMissingCredentialsFilterOffService {
  @readonly
  entity Books as projection on my.Books { ID, title, stock };
}
