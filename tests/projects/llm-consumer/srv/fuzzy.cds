@agent @odata
service fuzzy {
  action get_weather(city: String not null,
                     country: String not null)     returns String;

  action llm(message: String not null)             returns String;
  action llmStream(message: String not null)       returns @Core.MediaType LargeBinary;
  action agent(ID: UUID, message: String not null) returns @Core.MediaType LargeBinary;
}
