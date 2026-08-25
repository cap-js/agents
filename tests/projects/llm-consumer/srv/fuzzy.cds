@agent @odata
service fuzzy {
  action llm(message: String not null)             returns String;
  action llmStream(message: String not null)       returns String;
  action agent(ID: UUID, message: String not null) returns String;
}
