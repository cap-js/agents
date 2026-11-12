@agent @hcql
service TasksService {
  entity Tasks {
    key ID : Integer;
    due : DateTime;
    notes : Composition of many Notes on notes.task = $self;
  }
  entity Notes {
    key ID : Integer;
    task : Association to Tasks;
    text : String;
  }
}

service InternalService {
  entity Records { key ID : Integer; }
}
