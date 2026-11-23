@agent
@Core.Links : [ { rel : 'via', href : 'https://example.com/agent/with-proxy' } ]
service PlainCdsServiceWithProxy {

  function plainFunction() returns String;
}
