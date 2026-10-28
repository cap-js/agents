// Condition: a service with a co-located AGENTS.md and a skills/ folder.
// The AGENTS.md frontmatter OVERRIDES the card name/version/description,
// and every public skills/<id>/SKILL.md is appended to the card skills.
// A skill marked metadata.private is excluded.

@agent
service WithAgentsMdService {

  @description: 'Products in the shop.'
  @readonly
  entity Products {
    key ID    : UUID;
        name  : String(100);
  }

  @description: 'A service action.'
  action serviceAction() returns String;
}
