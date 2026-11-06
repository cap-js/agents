// Condition: a service defined by its .cds file only, with no AGENTS.md.
// The agent card skills are aggregated from sensible defaults + CDS annotations:
//   - one "query" skill summarising ALL entities (id, tags, description)
//   - one skill per action and function, with kind-specific tags and examples
//   - the query skill is listed before the action/function skills

@agent
service PlainCdsService {

  @readonly
  @description: 'The first simple entity.'
  entity FirstSimpleEntity {
    key ID : UUID;
  }

  @readonly
  @description: 'The second simple entity.'
  entity SecondSimpleEntity {
    key ID : UUID;
  }

  /**
   * Executes the annotated action.
   *
   * Example: run the annotated action
   * Example: trigger it twice
   */
  @description: 'The annotated action.'
  action annotatedAction() returns String;

  function plainFunction() returns String;
}
