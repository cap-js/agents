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
