// Condition: a service defined by its .cds file only, with no AGENTS.md.
// The agent card is built from sensible defaults + CDS annotations:
//   - card name  = the service name
//   - query skill description includes each entity's @description
//   - one action skill per action

@agent
service PlainCdsService {

  @description: 'Books available in the catalog.'
  @readonly
  entity Books {
    key ID    : UUID;
        title : String(100);
  }

  @description: 'Reserve a book by title. Example: Reserve Moby Dick'
  @agent.hitl
  action reserve(title : String) returns String;
}
